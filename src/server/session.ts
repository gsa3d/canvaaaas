// Состояние приложения: открытый документ, очередь задач на генерацию и их варианты.
// Ответ модели каждого варианта хранится в размере куска, поэтому смена маски — только перевклейка,
// без новой генерации.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import sharp from 'sharp';
import { CanvasDocument, TILE_SIZE, type DocObject, type NewPatch, type Patch } from '../core/document.ts';
import { encodeImage, formatOf, inspectImage, writeFileAtomic, type ImageFile, type ImageFormat } from '../core/image-file.ts';
import { encodeProject, isProject, isProjectPath, openProject, PROJECT_EXTENSION } from '../core/project.ts';
import type { RecentFiles } from '../core/recent.ts';
import {
  blendFrame,
  buildLayer,
  criticImages,
  directorImages,
  fitGenerated,
  insideOf,
  layerAsGen,
  measure,
  overviewImage,
  prepareEdit,
  retarget,
  revise,
  type Guide,
  type PreparedEdit,
  type RawImage,
} from '../core/edit-region.ts';
import { intersect, type Rect } from '../core/frame.ts';
import { expandMaskByDiff } from '../core/expand.ts';
import { readLedger, withDirectorLedger, withLedger } from '../core/ledger.ts';
import { featherAlpha, featherAlphaRegion, maskBBox } from '../core/mask.ts';
import { applyShapes, applyShapesRegion, type MaskLookup } from '../core/mask-shapes.ts';
import { changeEdge, wand } from '../core/lines.ts';
import { descendants, dilate, layerName, placeObject, removeObject, trim } from '../core/objects.ts';
import type { Bitmap } from '../core/segment.ts';
import type { KeyStore } from '../core/secrets.ts';
import { checkSketch } from '../core/sketch.ts';
import { chatgptCodex, chatgptDirector, findCodex } from '../providers/chatgpt-codex.ts';
import { mockDirector, type PromptDirector } from '../providers/director.ts';
import { laozhangGemini } from '../providers/laozhang-gemini.ts';
import { mockProvider } from '../providers/mock.ts';
import type { ImageProvider, InputImage } from '../providers/types.ts';
import { maskPng, Segmentation } from './segmentation.ts';
import {
  MAX_REFERENCES,
  shapesBBox,
  type CreateJobRequest,
  type DetachRequest,
  type EdgeRequest,
  type MaskResult,
  type JobDto,
  type MaskEditResult,
  type MaskShape,
  type ModelChoice,
  type PatchVariantsRequest,
  type PickRequest,
  type PickResult,
  type RectDto,
  type RedoChange,
  type SnapRequest,
  type WandRequest,
  type SizeChoice,
  type SketchStroke,
  type StateDto,
} from '../shared/api.ts';

const MAX_RUNNING_JOBS = 2;
const MAX_VARIANTS_PER_JOB = 8;
const REFERENCES_KEPT = 30;
/** Референс уменьшается до этого размера по большей стороне: модели больше не нужно */
const REFERENCE_SIZE = 1536;
/** Картинки для правки маски в браузере — не больше этого по большей стороне */
const EDIT_PREVIEW_MAX = 2560;
/** Задача модели, когда объект отделяют: на его месте — то, что вокруг */
const FILL_TASK = 'Пустое место: продолжить то, что вокруг (землю, стены, фон), как будто здесь ничего не стояло. Нового предмета не рисовать.';
/** Слой отделённого объекта берёт пиксели чуть шире маски, чтобы контур не обрезался, и гаснет к краю на столько же */
const LIFT_GROW = 2;
const LIFT_FEATHER = 2;

/** Насколько шире объекта модель дорисовывает фон: контур и сглаживание вокруг него тоже уходят */
function fillGrow(rect: Rect): number {
  return Math.min(40, Math.max(6, Math.round(0.02 * Math.max(rect.width, rect.height))));
}

interface Reference {
  image: InputImage;
  thumb: Buffer;
}

interface Variant {
  n: number;
  status: 'running' | 'done' | 'error';
  error?: string;
  elapsedMs?: number;
  /** Ответ модели в размере рамки куска, RGB */
  gen?: Buffer;
  outsideChangedPct?: number;
  insideChangedPct?: number;
  /** Версия, от которой просили ещё вариантов: она сама — вариант №1 */
  current?: boolean;
  /** Версия слоя, которой вариант лёг */
  patch?: string;
  /** С какой задачей и показом области сделан: ими же ляжет слой */
  prompt: string;
  hide: boolean;
  /** Задача, как её расписал директор */
  directed?: string;
  /** Шаг с критиком: исправляет вариант base по этим замечаниям */
  fixes?: string;
  base?: number;
  /** Что критик сказал о варианте и при какой маске задачи (maskRev) смотрел */
  critique?: Critique;
}

interface Critique {
  done: boolean;
  text: string;
  maskRev: number;
}

/** Версия, от которой новые варианты: маска и место — на момент, когда попросили ещё вариантов */
interface Replaced {
  patchId: string;
  mask: Uint8Array;
  rect: Rect;
  feather: number;
}

interface Job {
  id: string;
  docId: string;
  /** Задача следующих вариантов: повтор с поправкой её меняет */
  prompt: string;
  /** Стирать модели то, что под маской */
  hide: boolean;
  style: string;
  model: ModelChoice;
  size: SizeChoice;
  createdAt: string;
  status: JobDto['status'];
  error?: string;
  shapes: MaskShape[];
  /** Маски объектов из выделения: берутся сразу, пока они есть */
  bitmaps: Map<string, Bitmap>;
  /** Слой, в который ложатся версии: выделили слой — он; иначе слой появится из выделения с первым готовым вариантом */
  object?: string;
  /** Дорисовать фон под этим слоем: варианты — версии его заплатки фона */
  detach?: string;
  /** Границы выделения — известны сразу, ещё до подготовки куска */
  area: RectDto;
  variantsRequested: number;
  references: InputImage[];
  sketch: SketchStroke[];
  /** Перед генерацией задачу расписывает директор */
  director: boolean;
  /** Что директор написал и для какой задачи (taskKey): та же задача — тот же текст, без нового вызова */
  directed?: { key: string; text: string };
  directing: boolean;
  /** Критик смотрит вариант */
  reviewing: boolean;
  /** Идут шаги с критиком */
  chain?: { step: number; steps: number };
  /** Ещё варианты версии: модель видит холст без неё, она сама — вариант №1 */
  from?: Replaced;
  prep?: PreparedEdit;
  /** Текущая маска части куска внутри холста — её можно править после генерации */
  mask?: Uint8Array;
  alpha?: Float32Array;
  /** Растёт при каждой смене маски */
  maskRev: number;
  variants: Variant[];
  selected: number;
  /** Вариант выбрали руками: новые готовые его не перебивают */
  picked: boolean;
  rev: number;
  abort: AbortController;
  /** Правки маски идут строго по очереди */
  maskChain: Promise<unknown>;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Окна выбора файла и вопросы пользователю. Их даёт Electron; у сервера для разработки их нет */
export interface Host {
  /** Путь к картинке или проекту или null, если пользователь передумал */
  chooseOpen(): Promise<string | null>;
  /** message — пояснение над окном сохранения (на macOS); project: false — только картинки, без .caaa */
  chooseSave(defaultPath: string, opts?: { message?: string; project?: boolean }): Promise<string | null>;
  /** Номер нажатой кнопки; последняя кнопка — отмена */
  ask(question: { message: string; detail?: string; buttons: string[] }): Promise<number>;
}

export interface SessionOptions {
  host?: Host;
  recent?: RecentFiles;
}

/** Во что записывается документ: картинка или проект .caaa со слоями */
type SaveFormat = ImageFormat | typeof PROJECT_EXTENSION;

/** Открытый файл; у проекта .caaa нет ограничений картинки (blocker, прореживание цвета) */
type OpenFile = Omit<ImageFile, 'format'> & { format: SaveFormat };

function stem(name: string): string {
  return name.slice(0, name.length - extname(name).length) || name;
}

export class Session {
  readonly providerKind: 'laozhang' | 'mock';
  private readonly keys: KeyStore;
  private hasKey = false;
  /** Codex CLI для ChatGPT по подписке; ищется заново при каждой генерации, здесь — для настроек */
  private codex: string | null = null;
  doc: CanvasDocument | null = null;
  private jobs: Job[] = [];
  private readonly providers = new Map<ModelChoice, ImageProvider>();
  private directorImpl: PromptDirector | null = null;
  private generations = 0;
  private todayAtStart = 0;
  private readonly listeners = new Set<() => void>();
  private readonly references = new Map<string, Reference>();
  private emitTimer: NodeJS.Timeout | undefined;
  host: Host | null;
  private readonly recent: RecentFiles | null;
  /** Файл, открытый с диска; null — новый холст или картинка, загруженная из браузера */
  private file: OpenFile | null = null;
  /** Разрешение для печати: из исходника или из пресета нового холста */
  private density: number | undefined;
  /** Содержимое холста на момент последнего сохранения (contentKey документа) */
  private savedKey = '';
  /** Слои со скрытыми на момент сохранения (layersKey документа): в проект .caaa ложатся и они */
  private savedLayers = '';
  /** Стиль на момент сохранения: в проект .caaa он записывается, в картинку — нет */
  private savedStyle = '';
  /** Объекты на момент сохранения (objectsKey документа) */
  private savedObjects = '';
  /** Выделение объектов: модель SAM и маски под щелчком */
  readonly segmentation: Segmentation;
  /** Документ со слоями уже записывали картинкой: «Сохранить» больше не спрашивает, сохранить ли слои */
  private flattened = false;
  /** Что сервер сейчас делает с файлом: «Открываю…», «Сохраняю…» */
  private activity: string | null = null;
  /** Открытый вопрос «Сохранить изменения?»: второй ⌘Q не должен открыть второй */
  private asking: Promise<boolean> | null = null;
  /** Правки масок слоёв, отмена и повтор идут строго по очереди: ⌘Z сразу после мазка отменяет этот мазок */
  private docChain: Promise<unknown> = Promise.resolve();
  /** Холст под правимым слоем и над ним: браузер просит обе картинки разом */
  private aroundCache: { key: string; below: Buffer; above: Buffer } | null = null;
  /** Холст, по которому построены превью замены слоя (rev документа) */
  private previewRev: number | undefined;
  /** Какие ответы умеет каждая модель — не меняется */
  private outputs: StateDto['models'] | undefined;

  constructor(providerKind: 'laozhang' | 'mock', keys: KeyStore, opts: SessionOptions = {}) {
    this.providerKind = providerKind;
    this.keys = keys;
    this.host = opts.host ?? null;
    this.recent = opts.recent ?? null;
    this.segmentation = new Segmentation(() => this.changed());
  }

  async init(): Promise<void> {
    this.hasKey = (await this.keys.get()) !== null;
    this.codex = findCodex();
    if (this.providerKind !== 'laozhang') return;
    const today = new Date().toISOString().slice(0, 10);
    this.todayAtStart = (await readLedger()).filter((e) => e.at.startsWith(today) && !e.kind).length;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = undefined;
      for (const fn of this.listeners) fn();
    }, 50);
  }

  private provider(model: ModelChoice): ImageProvider {
    let p = this.providers.get(model);
    if (!p) {
      p =
        this.providerKind === 'mock'
          ? mockProvider({ mode: 'blob', delayMs: 1500 })
          : model === 'chatgpt'
            ? withLedger(chatgptCodex(), 'ui')
            : withLedger(laozhangGemini({ model, apiKey: () => this.apiKey() }), 'ui');
      this.providers.set(model, p);
    }
    return p;
  }

  private director(): PromptDirector {
    this.directorImpl ??= this.providerKind === 'mock' ? mockDirector({ delayMs: 800 }) : withDirectorLedger(chatgptDirector(), 'ui');
    return this.directorImpl;
  }

  private async apiKey(): Promise<string> {
    const key = await this.keys.get();
    if (!key) throw new Error('Нет ключа laozhang.ai: добавьте его в настройках (⌘,)');
    return key;
  }

  async setKey(key: string): Promise<void> {
    await this.keys.set(key);
    this.hasKey = (await this.keys.get()) !== null;
    this.changed();
  }

  async clearKey(): Promise<void> {
    await this.keys.clear();
    this.hasKey = (await this.keys.get()) !== null;
    this.changed();
  }

  /** Размеры ответа каждой модели по пропорциям и разрешениям */
  private modelOutputs(): StateDto['models'] {
    const of = (model: ModelChoice) => {
      const p = this.provider(model);
      const outputs = Object.fromEntries(p.aspectRatios.map((ar) => [ar, Object.fromEntries(p.imageSizes.map((size) => [size, p.outputSize(ar, size)]))]));
      return { imageSizes: [...p.imageSizes], outputs };
    };
    this.outputs ??= { flash: of('flash'), pro: of('pro'), chatgpt: of('chatgpt') };
    return this.outputs;
  }

  state(): StateDto {
    const doc = this.doc;
    return {
      provider: this.providerKind,
      models: this.modelOutputs(),
      hasKey: this.hasKey || this.providerKind === 'mock',
      codex: this.codex,
      doc: doc && {
        id: doc.id,
        name: doc.name,
        width: doc.width,
        height: doc.height,
        rev: doc.rev,
        levels: doc.levelCount,
        tileSize: TILE_SIZE,
        style: doc.style,
        path: this.file?.path ?? null,
        project: this.file?.format === PROJECT_EXTENSION,
        dirty: this.dirty,
        saveBlocker: this.file?.blocker,
      },
      jobs: this.jobs.map((j) => ({
        id: j.id,
        prompt: j.prompt,
        hide: j.hide,
        model: j.model,
        status: j.status,
        error: j.error,
        createdAt: j.createdAt,
        refs: j.references.length,
        sketch: j.sketch.length > 0,
        director: j.director,
        directing: j.directing,
        reviewing: j.reviewing,
        chain: j.chain && { ...j.chain },
        directed: j.director && j.directed?.key === taskKey(j) ? j.directed.text : undefined,
        bbox: j.prep?.bbox ?? j.area,
        inside: j.prep?.frame.inside,
        imageSize: j.prep?.imageSize,
        modelSize: j.prep?.modelSize,
        warnings: j.prep?.warnings ?? [],
        variants: j.variants.map((v) => ({
          n: v.n,
          status: v.status,
          error: v.error,
          elapsedMs: v.elapsedMs,
          outsideChangedPct: v.outsideChangedPct,
          insideChangedPct: v.insideChangedPct,
          current: v.current,
          patch: v.patch,
          prompt: v.prompt,
          hide: v.hide,
          directed: v.directed,
          fixes: v.fixes,
          base: v.base,
          critique: v.critique && { done: v.critique.done, text: v.critique.text },
        })),
        selected: j.selected,
        rev: j.rev,
        maskRev: j.maskRev,
        feather: j.prep?.feather,
        from: j.from?.patchId,
        object: j.object,
        detach: j.detach,
      })),
      history: (doc?.patches ?? []).map((p) => ({
        id: p.id,
        prompt: p.prompt,
        rect: p.rect,
        active: p.active,
        createdAt: p.createdAt,
        maskRev: p.maskVersion,
        model: p.model,
        feather: p.feather,
        hide: p.hide,
        directed: p.directed,
        sketch: !!p.sketch?.length,
        object: p.object,
        lifted: p.lifted,
      })),
      objects: (doc?.objects ?? []).map((o) => ({
        id: o.id,
        name: o.name,
        rect: o.rect,
        parent: o.parent,
        rev: o.version,
        lost: o.lost,
        hidden: o.hidden,
        current: o.current,
        kind: o.kind,
        under: o.under,
        versions: doc!.patches.filter((p) => p.object === o.id && !p.lifted).map((p) => p.id),
        layer: liftedLayer(doc!, o.id)?.id,
      })),
      segment: this.segmentation.state(),
      canUndo: doc?.canUndo ?? false,
      canRedo: doc?.canRedo ?? false,
      generations: { session: this.generations, today: this.todayAtStart + this.generations },
      recent: this.recentFiles().map((e) => ({
        id: e.id,
        name: e.name,
        path: e.path,
        width: e.width,
        height: e.height,
        openedAt: e.openedAt,
      })),
      activity: this.activity,
      nativeFiles: this.host !== null,
    };
  }

  /** Недавние файлы, которые ещё лежат на месте */
  recentFiles() {
    return (this.recent?.list() ?? []).filter((e) => existsSync(e.path));
  }

  // ——— Документ ———

  /** Путь к открытому файлу; null — у документа файла нет */
  get filePath(): string | null {
    return this.file?.path ?? null;
  }

  /** Есть несохранённые изменения холста и объектов; у проекта .caaa — ещё скрытых слоёв и стиля */
  get dirty(): boolean {
    if (!this.doc) return false;
    if (this.doc.objectsKey !== this.savedObjects) return true;
    if (this.file?.format === PROJECT_EXTENSION) return this.doc.layersKey !== this.savedLayers || this.doc.style !== this.savedStyle;
    return this.doc.contentKey !== this.savedKey;
  }

  /** При закрытии документа есть что потерять: несохранённые правки или задачи в очереди */
  needsConfirm(): boolean {
    return this.dirty || this.jobs.length > 0;
  }

  /** «Открыть…»: окно выбора файла. false — пользователь передумал */
  async openWithDialog(): Promise<boolean> {
    const path = await this.requireHost().chooseOpen();
    if (!path) return false;
    return this.openPath(path);
  }

  async openPath(path: string): Promise<boolean> {
    if (!(await this.confirmClose())) return false;
    this.setActivity(`Открываю ${basename(path)}…`);
    try {
      if (isProjectPath(path)) {
        const info = await stat(path);
        const { doc, density } = await openProject(await readFile(path), basename(path));
        this.replaceDoc(doc, { path, format: PROJECT_EXTENSION, density, size: info.size, mtimeMs: info.mtimeMs }, density);
        await this.remember(doc, path);
      } else {
        const [doc, file] = await Promise.all([CanvasDocument.open(path, basename(path)), inspectImage(path)]);
        this.replaceDoc(doc, file, file.density);
        await this.remember(doc, path);
      }
    } finally {
      this.setActivity(null);
    }
    return true;
  }

  async openRecent(id: string): Promise<boolean> {
    const entry = this.recent?.get(id);
    if (!entry) throw new Error('Этого файла уже нет в списке недавних');
    if (!existsSync(entry.path)) {
      await this.recent?.remove(id);
      this.changed();
      throw new Error(`Файл не найден: ${entry.path}`);
    }
    return this.openPath(entry.path);
  }

  async clearRecent(): Promise<void> {
    await this.recent?.clear();
    this.changed();
  }

  recentThumb(id: string): string {
    if (!this.recent?.get(id)) throw new Error('Нет такого файла в списке недавних');
    return this.recent.thumbPath(id);
  }

  /** Картинка или проект, загруженные из браузера (сервер для разработки): пути к файлу нет, «Сохранить» их не перезапишет */
  async openDocument(input: Buffer, name: string): Promise<boolean> {
    if (!(await this.confirmClose())) return false;
    if (isProject(input)) {
      const { doc, density } = await openProject(input, name);
      this.replaceDoc(doc, null, density);
    } else {
      this.replaceDoc(await CanvasDocument.open(input, name), null, undefined);
    }
    return true;
  }

  async newDocument(width: number, height: number, color: [number, number, number], density?: number): Promise<boolean> {
    if (!(await this.confirmClose())) return false;
    this.replaceDoc(CanvasDocument.blank(width, height, color, `Холст ${width}×${height}`), null, density);
    return true;
  }

  private replaceDoc(doc: CanvasDocument, file: OpenFile | null, density: number | undefined): void {
    this.dropAllJobs();
    this.doc = doc;
    this.file = file;
    this.density = density;
    this.savedKey = doc.contentKey;
    this.savedLayers = doc.layersKey;
    this.savedStyle = doc.style;
    this.savedObjects = doc.objectsKey;
    this.flattened = false;
    this.changed();
  }

  /**
   * Можно ли закрыть документ. Если есть несохранённые правки или задачи в очереди, спрашивает;
   * false — пользователь передумал. Без окон (сервер для разработки) не спрашивает.
   */
  confirmClose(): Promise<boolean> {
    if (!this.doc || !this.needsConfirm() || !this.host) return Promise.resolve(true);
    this.asking ??= this.askClose(this.host).finally(() => {
      this.asking = null;
    });
    return this.asking;
  }

  private async askClose(host: Host): Promise<boolean> {
    const doc = this.requireDoc();
    const jobs = this.jobs.length;
    const lost = jobs ? `${jobs} ${jobs === 1 ? 'правка' : jobs < 5 ? 'правки' : 'правок'} в очереди` : '';
    if (this.dirty) {
      const answer = await host.ask({
        message: `Сохранить изменения в «${doc.name}»?`,
        detail: `Если не сохранить, все изменения после последнего сохранения пропадут насовсем.${lost ? ` ${lost[0]!.toUpperCase()}${lost.slice(1)} пропадут в любом случае.` : ''}`,
        buttons: ['Сохранить', 'Не сохранять', 'Отмена'],
      });
      if (answer === 0) return (await this.save()) !== null;
      return answer === 1;
    }
    const answer = await host.ask({
      message: `Закрыть «${doc.name}»? У вас ${lost}.`,
      detail: 'Непринятые варианты пропадут, идущие генерации остановятся.',
      buttons: ['Закрыть', 'Отмена'],
    });
    return answer === 0;
  }

  /**
   * «Сохранить»: документ записывается в открытый файл. Проект .caaa — со слоями; картинка со слоями
   * сначала спрашивает, не сохранить ли их в .caaa, потому что в картинке они сольются. Новый холст и файл,
   * который без потерь не перезаписать, идут через «Сохранить как». Возвращает путь или null, если пользователь передумал.
   */
  async save(): Promise<string | null> {
    const doc = this.requireDoc();
    const file = this.file;
    if (file?.format === PROJECT_EXTENSION) return this.overwrite(file);
    if ((doc.patches.length || doc.objects.length) && !this.flattened && this.host) {
      const answer = await this.host.ask({
        message: 'Сохранить слои?',
        detail:
          'Слои и их версии останутся, только если сохранить документ в формате canvaaaas (.caaa): после повторного открытия их можно будет переключать, скрывать и править. В картинке видимое сольётся с холстом.',
        buttons: ['Сохранить в .caaa…', file && !file.blocker ? `Записать в «${doc.name}»` : 'Сохранить картинкой…', 'Отмена'],
      });
      if (answer === 0) return this.saveAs({ kind: 'project' });
      if (answer !== 1) return null;
    }
    if (!file || file.blocker) return this.saveAs({ kind: 'image', reason: file?.blocker });
    return this.overwrite(file);
  }

  /** Записать поверх открытого файла; если его изменила другая программа — спросить */
  private async overwrite(file: OpenFile): Promise<string | null> {
    const doc = this.requireDoc();
    const now = await stat(file.path).catch(() => null);
    if (now && (now.size !== file.size || now.mtimeMs !== file.mtimeMs)) {
      if (!this.host) throw new Error(`Файл «${doc.name}» изменила другая программа: сохраните под другим именем`);
      const answer = await this.host.ask({
        message: `Файл «${doc.name}» изменила другая программа`,
        detail: 'Если перезаписать его, эти изменения пропадут.',
        buttons: ['Перезаписать', 'Сохранить как…', 'Отмена'],
      });
      if (answer === 1) return this.saveAs();
      if (answer !== 0) return null;
    }
    await this.write(file.path, file.format, file.chromaSubsampling);
    return file.path;
  }

  /** Слои и объекты документа пойдут в .caaa, а не сольются в картинку */
  private keepsLayers(): boolean {
    const doc = this.requireDoc();
    return this.file?.format === PROJECT_EXTENSION || ((doc.patches.length > 0 || doc.objects.length > 0) && !this.flattened);
  }

  /** Папка для окна сохранения: открытого файла или последнего из недавних */
  private saveDir(): string | undefined {
    const recent = this.recentFiles()[0];
    return this.file ? dirname(this.file.path) : recent && dirname(recent.path);
  }

  /**
   * «Сохранить как…»: новый файл, формат — по расширению: .caaa со слоями или картинка (PNG, JPEG, WebP, TIFF).
   * kind — что предложить по умолчанию; без него — проект, если слои есть и их ещё не сливали в картинку.
   */
  async saveAs(opts: { kind?: 'project' | 'image'; reason?: string } = {}): Promise<string | null> {
    const doc = this.requireDoc();
    const host = this.requireHost();
    const project = (opts.kind ?? (this.keepsLayers() ? 'project' : 'image')) === 'project';
    const name = project
      ? `${stem(doc.name)}.${PROJECT_EXTENSION}`
      : this.file?.blocker
        ? `${stem(doc.name)}-canvaaaas.png`
        : this.file && this.file.format !== PROJECT_EXTENSION
          ? doc.name
          : `${stem(doc.name)}.png`;
    const dir = this.saveDir();
    let path = await host.chooseSave(dir ? join(dir, name) : name, { message: opts.reason });
    if (!path) return null;
    let format: SaveFormat | null = isProjectPath(path) ? PROJECT_EXTENSION : formatOf(path);
    if (!format) {
      format = project ? PROJECT_EXTENSION : 'png';
      path += `.${format}`;
    }
    await this.write(path, format, this.file?.path === path ? this.file.chromaSubsampling : undefined);
    doc.name = basename(path);
    this.changed();
    return path;
  }

  /** «Экспортировать картинку…»: холст со слоями в отдельный файл; документ остаётся связан со своим файлом */
  async exportImage(): Promise<string | null> {
    const doc = this.requireDoc();
    const host = this.requireHost();
    const dir = this.saveDir();
    const name = `${stem(doc.name)}.png`;
    let path = await host.chooseSave(dir ? join(dir, name) : name, { project: false });
    if (!path) return null;
    let format = formatOf(path);
    if (!format) {
      format = 'png';
      path += '.png';
    }
    this.setActivity(`Экспортирую ${basename(path)}…`);
    try {
      await writeFileAtomic(path, await encodeImage(doc.snapshot(), format, { density: this.density }));
    } finally {
      this.setActivity(null);
    }
    return path;
  }

  private async write(path: string, format: SaveFormat, chromaSubsampling?: string): Promise<void> {
    const doc = this.requireDoc();
    this.setActivity(`Сохраняю ${basename(path)}…`);
    try {
      const key = doc.contentKey;
      const layers = doc.layersKey;
      const style = doc.style;
      const objects = doc.objectsKey;
      const data =
        format === PROJECT_EXTENSION
          ? await encodeProject(doc, this.density)
          : await encodeImage(doc.snapshot(), format, { density: this.density, chromaSubsampling });
      await writeFileAtomic(path, data);
      const info = await stat(path);
      this.file = { path, format, density: this.density, chromaSubsampling, size: info.size, mtimeMs: info.mtimeMs };
      this.savedKey = key;
      this.savedLayers = layers;
      this.savedStyle = style;
      this.savedObjects = objects;
      if (format !== PROJECT_EXTENSION) this.flattened = true;
      await this.remember(doc, path);
    } finally {
      this.setActivity(null);
    }
  }

  /** В список недавних; сбой списка не мешает открыть или сохранить файл */
  private async remember(doc: CanvasDocument, path: string): Promise<void> {
    if (!this.recent) return;
    try {
      await this.recent.add({ path, name: basename(path), width: doc.width, height: doc.height }, await doc.thumbnail());
    } catch {
      // не удалось записать список — не страшно
    }
  }

  private setActivity(text: string | null): void {
    this.activity = text;
    this.changed();
  }

  private requireHost(): Host {
    if (!this.host) throw new Error('Окна выбора файла есть только в приложении canvaaaas');
    return this.host;
  }

  setStyle(style: string): void {
    this.requireDoc().style = style;
    this.changed();
  }

  /** Проект .caaa для скачивания (сервер для разработки, где нет окна сохранения) */
  exportProject(): Promise<Buffer> {
    return encodeProject(this.requireDoc(), this.density);
  }

  private serialDoc<T>(fn: (doc: CanvasDocument) => Promise<T> | T): Promise<T> {
    const next = this.docChain.then(() => fn(this.requireDoc()));
    this.docChain = next.catch(() => undefined);
    return next;
  }

  undo(): Promise<void> {
    return this.serialDoc((doc) => {
      doc.undo();
      this.changed();
    });
  }

  redo(): Promise<void> {
    return this.serialDoc((doc) => {
      doc.redo();
      this.changed();
    });
  }

  togglePatch(patchId: string): Promise<void> {
    return this.serialDoc((doc) => {
      doc.togglePatch(patchId);
      this.changed();
    });
  }

  /** Удалить версию слоя: если она была на холсте, слой показывает предыдущую (или исходник). Шаг ⌘Z */
  removePatch(patchId: string): Promise<void> {
    return this.serialDoc((doc) => {
      const patch = doc.patch(patchId);
      if (patch.lifted) throw new Error('Исходник не удалить: удалите слой');
      const owner = patch.object ? doc.objects.find((o) => o.id === patch.object) : undefined;
      doc.batch(() => {
        if (owner?.current === patchId) {
          const versions = doc.patches.filter((p) => p.object === owner.id && !p.lifted);
          const prev = versions[versions.findIndex((p) => p.id === patchId) - 1];
          doc.setObjects(doc.objects.map((o) => (o === owner ? { ...o, current: prev?.id } : o)));
        }
        doc.removePatch(patchId);
      });
      this.changed();
    });
  }

  /**
   * Дорисовать или стереть маску принятого слоя: кисть возвращает его пиксели, ластик открывает холст под ним.
   * Пересчитывается только участок около мазка, поэтому холст догоняет кисть быстро и на большом слое.
   */
  editPatchMask(patchId: string, shapes: MaskShape[]): Promise<MaskEditResult> {
    return this.serialDoc(async (doc) => {
      const patch = doc.patch(patchId);
      const { mask, changed } = await applyShapesRegion(patch.mask, patch.rect, shapes);
      if (this.doc !== doc) throw new Error('Документ уже закрыт');
      if (changed) {
        doc.batch(() => {
          doc.setPatchMask(patchId, mask, changed);
          // Маска отделённого объекта — это маска его слоя: стёртое ластиком уходит и из объекта
          const obj = patch.lifted && patch.object ? doc.objects.find((o) => o.id === patch.object) : undefined;
          const bitmap = obj && trim({ rect: patch.rect, mask });
          if (obj && bitmap) doc.setObjects(doc.objects.map((o) => (o === obj ? { ...o, ...bitmap, version: doc.nextObjectVersion() } : o)));
        });
      }
      this.changed();
      return { version: patch.maskVersion, rev: doc.rev };
    });
  }

  /**
   * Картинки, по которым браузер сам показывает правку маски версии, не дожидаясь сервера: холст под ней,
   * версии над ней, ответ модели на весь кусок и маска до растушёвки — в размере превью. version — чья маска в картинке.
   */
  async maskEditImage(patchId: string, part: string): Promise<{ data: Buffer; type: string; version: number }> {
    const doc = this.requireDoc();
    const patch = doc.patch(patchId);
    const { rect, mask, maskVersion: version } = patch;
    const skip = patch.id;
    const rgb = () => {
      const out = Buffer.alloc(rect.width * rect.height * 3);
      for (let i = 0; i < rect.width * rect.height; i++) patch.layer.copy(out, i * 3, i * 4, i * 4 + 3);
      return out;
    };
    const k = Math.min(1, EDIT_PREVIEW_MAX / Math.max(rect.width, rect.height));
    const scaled = (data: Uint8Array, channels: 1 | 3 | 4) => {
      const img = sharp(data, { raw: { width: rect.width, height: rect.height, channels } });
      if (k === 1) return img;
      return img.resize(Math.max(1, Math.round(rect.width * k)), Math.max(1, Math.round(rect.height * k)), {
        fit: 'fill',
        kernel: channels === 1 ? 'linear' : 'lanczos3',
      });
    };
    const jpeg = async (data: Uint8Array) => ({ data: await scaled(data, 3).jpeg({ quality: 90 }).toBuffer(), type: 'image/jpeg', version });
    const png = async (data: Uint8Array, channels: 1 | 4) => ({ data: await scaled(data, channels).png({ compressionLevel: 2 }).toBuffer(), type: 'image/png', version });
    if (part === 'layer') return jpeg(rgb());
    if (part === 'mask') return png(mask, 1);
    if (part !== 'below' && part !== 'above') throw new Error('Нет такой картинки');
    const key = `${doc.id}:${skip}:${rect.x},${rect.y},${rect.width},${rect.height}:${doc.layersKey}`;
    if (this.aroundCache?.key !== key) this.aroundCache = { key, ...doc.regionAround(rect, skip) };
    return part === 'below' ? jpeg(this.aroundCache.below) : png(this.aroundCache.above, 4);
  }

  private requireDoc(): CanvasDocument {
    if (!this.doc) throw new Error('Документ не открыт');
    return this.doc;
  }

  private dropAllJobs(): void {
    for (const j of this.jobs) j.abort.abort();
    this.jobs = [];
  }

  // ——— Референсы ———

  /** Картинка-референс: приводится к sRGB JPEG не больше REFERENCE_SIZE, хранится до конца сеанса */
  async addReference(data: Buffer): Promise<string> {
    const jpeg = await sharp(data, { limitInputPixels: false, autoOrient: true })
      .flatten({ background: '#ffffff' })
      .toColourspace('srgb')
      .resize(REFERENCE_SIZE, REFERENCE_SIZE, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 90 })
      .toBuffer();
    const thumb = await sharp(jpeg).resize(160, 160, { fit: 'cover' }).jpeg({ quality: 80 }).toBuffer();
    const id = randomUUID();
    this.references.set(id, { image: { data: jpeg, mimeType: 'image/jpeg' }, thumb });
    while (this.references.size > REFERENCES_KEPT) this.references.delete(this.references.keys().next().value!);
    return id;
  }

  referenceThumb(id: string): Buffer {
    const ref = this.references.get(id);
    if (!ref) throw new Error('Нет такого референса');
    return ref.thumb;
  }

  // ——— Задачи ———

  createJob(req: CreateJobRequest): string {
    if (!req.prompt.trim()) throw new Error('Пустой промпт');
    const { shapes, bitmaps } = this.resolveShapes(req.shapes);
    const area = shapesBBox(shapes);
    if (!area) throw new Error('Нет выделения');
    const added = shapes.filter((s) => !s.erase);
    const only = added.length === 1 && added[0]!.kind === 'mask' ? added[0]!.id : '';
    const refIds = req.refs ?? [];
    if (refIds.length > MAX_REFERENCES) throw new Error(`Не больше ${MAX_REFERENCES} референсов на правку`);
    const references = refIds.map((id) => {
      const ref = this.references.get(id);
      if (!ref) throw new Error('Референс не найден — добавьте картинку заново');
      return ref.image;
    });
    const object = only.startsWith('obj:') ? only.slice(4) : undefined;
    return this.enqueue({
      prompt: req.prompt.trim(),
      hide: !!req.hide,
      model: req.model,
      size: req.size,
      variants: req.variants,
      shapes,
      bitmaps,
      object,
      area,
      references,
      sketch: checkSketch(req.sketch),
      director: !!req.director,
    });
  }

  /** Маски объектов в выделении: где они сейчас лежат и сами маски — задача берёт их сразу */
  private resolveShapes(input: MaskShape[]): { shapes: MaskShape[]; bitmaps: Map<string, Bitmap> } {
    const bitmaps = new Map<string, Bitmap>();
    const shapes = input.map((s) => {
      if (s.kind !== 'mask') return s;
      const b = this.maskOf(s.id);
      bitmaps.set(s.id, b);
      return { ...s, ...b.rect };
    });
    return { shapes, bitmaps };
  }

  /**
   * «Ещё варианты» принятого слоя: та же задача (или поправленная), маска слоя, его референсы и набросок; модель видит холст
   * под слоем, а не его самого. Нынешний слой становится первым вариантом, чтобы новые было с чем сравнить;
   * «Принять» кладёт выбранный на его место. С той же задачей директор не нужен заново: слой помнит его текст.
   */
  patchVariants(patchId: string, req: PatchVariantsRequest): string {
    const patch = this.requireDoc().patch(patchId);
    if (patch.lifted) throw new Error('Исходник перерисовывают правкой: выделите слой и напишите задачу');
    const box = maskBBox(patch.mask, patch.rect.width, patch.rect.height);
    if (!box) throw new Error('Маска версии пустая: верните кистью то, что нужно перерисовать');
    return this.enqueue({
      prompt: req.prompt?.trim() || patch.prompt,
      hide: req.hide ?? patch.hide ?? false,
      model: patch.model ?? req.model,
      size: patch.size ?? req.size,
      variants: req.variants,
      shapes: [],
      bitmaps: new Map(),
      object: patch.object,
      area: { ...box, x: box.x + patch.rect.x, y: box.y + patch.rect.y },
      references: patch.refs ?? [],
      sketch: patch.sketch ?? [],
      director: req.director ?? patch.directed !== undefined,
      directed: patch.directed ? { key: taskKey({ prompt: patch.prompt, hide: patch.hide ?? false }), text: patch.directed } : undefined,
      from: { patchId, mask: patch.mask, rect: patch.rect, feather: patch.feather },
    });
  }

  private enqueue(
    task: Pick<
      Job,
      | 'prompt'
      | 'hide'
      | 'model'
      | 'size'
      | 'shapes'
      | 'bitmaps'
      | 'object'
      | 'detach'
      | 'area'
      | 'references'
      | 'sketch'
      | 'director'
      | 'directed'
      | 'from'
    > & {
      variants: number;
    },
  ): string {
    const doc = this.requireDoc();
    const job: Job = {
      ...task,
      // У ChatGPT одно разрешение: его выбирает сама модель
      size: task.model === 'chatgpt' ? 'auto' : task.size,
      id: randomUUID(),
      docId: doc.id,
      style: doc.style,
      createdAt: new Date().toISOString(),
      status: 'queued',
      variantsRequested: Math.min(Math.max(Math.round(task.variants), 1), 4),
      directing: false,
      reviewing: false,
      maskRev: 0,
      variants: [],
      selected: 0,
      picked: false,
      rev: 1,
      abort: new AbortController(),
      maskChain: Promise.resolve(),
    };
    this.jobs.push(job);
    this.changed();
    this.schedule();
    return job.id;
  }

  private job(jobId: string): Job {
    const job = this.jobs.find((j) => j.id === jobId);
    if (!job) throw new Error('Нет такой задачи');
    return job;
  }

  /** Задача с готовым куском и маской */
  private readyJob(jobId: string): Job & { prep: PreparedEdit; mask: Uint8Array; alpha: Float32Array } {
    const job = this.job(jobId);
    if (!job.prep || !job.mask || !job.alpha) throw new Error('Задача ещё не подготовлена');
    return job as Job & { prep: PreparedEdit; mask: Uint8Array; alpha: Float32Array };
  }

  private schedule(): void {
    let running = this.jobs.filter((j) => j.status === 'preparing' || j.status === 'running').length;
    for (const job of this.jobs) {
      if (running >= MAX_RUNNING_JOBS) break;
      if (job.status !== 'queued') continue;
      running++;
      void this.runJob(job);
    }
  }

  private async runJob(job: Job): Promise<void> {
    job.status = 'preparing';
    this.changed();
    try {
      const doc = this.doc;
      if (!doc || doc.id !== job.docId) throw new Error('Документ уже закрыт');
      // Версию могли удалить, пока задача ждала очереди: тогда варианты — просто новые версии
      const { from } = job;
      const current = from && doc.hasPatch(from.patchId) ? doc.patch(from.patchId) : null;
      const prep = await prepareEdit({
        image: doc.raw(),
        mask: from ? layerMask(from) : await this.rasterize(job, doc),
        crop: current ? (inside) => doc.regionWithout(inside, current.id) : undefined,
        feather: from?.feather,
        prompt: job.prompt,
        guide: guideOf(job.hide),
        style: job.style,
        provider: this.provider(job.model),
        imageSize: job.size,
        references: job.references,
        sketch: job.sketch,
      });
      job.prep = prep;
      job.mask = prep.insideMask;
      job.alpha = prep.alpha;
      if (current) {
        const gen = layerAsGen(prep, current.rect, current.layer);
        const stats = await measure(prep, gen, prep.modelSize);
        job.variants.push({
          n: 0,
          status: 'done',
          current: true,
          patch: current.id,
          gen,
          outsideChangedPct: stats.outsideChangedPct,
          insideChangedPct: stats.insideChangedPct,
          prompt: current.prompt,
          hide: current.hide ?? false,
          directed: current.directed,
        });
      }
      job.status = 'running';
      this.changed();
      await this.generate(job, job.variantsRequested);
    } catch (err) {
      job.status = 'error';
      job.error = message(err);
    } finally {
      this.changed();
      this.schedule();
    }
  }

  /** Маска только участка выделения: растеризовать весь холст ради неё в разы дольше */
  private async rasterize(job: Job, doc: CanvasDocument): Promise<RawImage & { x: number; y: number }> {
    const area = intersect(
      { x: job.area.x - 2, y: job.area.y - 2, width: job.area.width + 4, height: job.area.height + 4 },
      { x: 0, y: 0, width: doc.width, height: doc.height },
    );
    if (!area.width || !area.height) throw new Error('Выделение за пределами холста');
    const lookup: MaskLookup = (id) => {
      const b = job.bitmaps.get(id);
      if (!b) throw new Error('Маска объекта потерялась: выделите его заново');
      return b;
    };
    const region = await applyShapes(new Uint8Array(area.width * area.height), area, job.shapes, lookup);
    return { data: Buffer.from(region.buffer, region.byteOffset, region.length), width: area.width, height: area.height, channels: 1, x: area.x, y: area.y };
  }

  /**
   * Новые варианты с нынешней задачей и показом области задачи. Готовые остаются на холсте, пока идут новые:
   * их можно сравнивать и принимать. jump — задачу поправили: первый готовый новый вариант сразу на холсте.
   * С директором варианты идут не разом, а шагами с критиком (refine).
   */
  private async generate(job: Job, count: number, jump = false): Promise<void> {
    const prep = job.prep;
    if (!prep) throw new Error('Задача ещё не подготовлена');
    if (job.director) return this.refine(job, prep, count);
    const provider = this.provider(job.model);
    const task = { prompt: job.prompt, hide: job.hide };
    const fresh = Array.from({ length: count }, (_, i): Variant => ({ n: job.variants.length + i, status: 'running', ...task }));
    job.variants.push(...fresh);
    if (!job.variants.some((v) => v.status === 'done')) job.status = 'running';
    job.error = undefined;
    this.changed();

    // Промпт и картинки для модели собираются заново, только если задачу или показ области поправили
    // (или прежние варианты шли с директором)
    const ready = (async () => {
      const guide = guideOf(task.hide);
      if (prep.request !== task.prompt || prep.guide !== guide || prep.directed !== undefined) {
        Object.assign(prep, await retarget(prep, { request: task.prompt, guide }));
      }
      return { prompt: prep.prompt, images: prep.images };
    })();
    let shown = false;
    await Promise.all(
      fresh.map(async (v) => {
        try {
          const input = await ready;
          this.generations++;
          const res = await provider.generate({
            prompt: input.prompt,
            images: input.images,
            aspectRatio: prep.frame.aspectRatio,
            imageSize: prep.imageSize,
            signal: job.abort.signal,
          });
          const { gen, modelOutput } = await fitGenerated(prep, res.image);
          const stats = await measure(prep, gen, modelOutput);
          v.gen = gen;
          v.elapsedMs = res.elapsedMs;
          v.outsideChangedPct = stats.outsideChangedPct;
          v.insideChangedPct = stats.insideChangedPct;
          v.status = 'done';
          // Первый готовый новый вариант сразу на холсте, даже если до него была версия, от которой просили ещё
          // (или вариант по прежней задаче), — если только пользователь сам не выбрал другую
          const selected = job.variants[job.selected];
          if (selected?.status !== 'done' || (!job.picked && (selected.current || (jump && !shown)))) job.selected = v.n;
          shown = true;
          await this.land(job, v, job.selected === v.n);
        } catch (err) {
          v.status = 'error';
          v.error = message(err);
        }
        this.changed();
      }),
    );
    const failed = job.variants.find((v) => v.status === 'error');
    job.status = job.variants.some((v) => v.status === 'done') ? 'done' : 'error';
    job.error = job.status === 'error' ? failed?.error : undefined;
  }

  /**
   * Шаги с директором и критиком. Директор расписывает задачу, модель делает вариант, критик смотрит его и говорит,
   * что исправить, — следующий шаг исправляет это в нём же. И так, пока критик не скажет «готово» или шаги не кончатся;
   * последний шаг критик тоже смотрит: его замечания видны в карточке и пригодятся, если попросят ещё шагов.
   * Каждый шаг — вариант: его можно выбрать и принять, пока идут следующие. С той же задачей шаги продолжают
   * выбранный вариант, с поправленной (или в новой задаче) — начинают с исходного куска.
   */
  private async refine(job: Job, prep: PreparedEdit, steps: number): Promise<void> {
    const provider = this.provider(job.model);
    const task = { prompt: job.prompt, hide: job.hide };
    // «Остановить» обрывает этот сигнал, но не задачу: готовые шаги остаются
    const { signal } = job.abort;
    const selected = job.variants[job.selected];
    let base = selected?.status === 'done' && taskKey(selected) === taskKey(task) ? selected : undefined;
    // Ещё шаги от готового варианта художник просит сам: «готово» от критика тут не ответ
    let mustFix = base !== undefined;
    let made = 0;
    let step: Variant | undefined;
    if (!job.variants.some((v) => v.status === 'done')) job.status = 'running';
    job.error = undefined;
    job.picked = false;
    job.chain = { step: 0, steps };
    this.changed();
    try {
      const directed = await this.direct(job, prep, task);
      const guide = guideOf(task.hide);
      if (prep.request !== task.prompt || prep.guide !== guide || prep.directed !== directed) {
        Object.assign(prep, await retarget(prep, { request: task.prompt, guide, directed }));
      }
      for (;;) {
        let fixes: string | undefined;
        if (base) {
          const verdict = await this.review(job, prep, base, { directed, mustFix, signal });
          mustFix = false;
          if (verdict.done || made === steps) break;
          fixes = verdict.text;
        }
        if (signal.aborted || job.variants.length >= MAX_VARIANTS_PER_JOB) break;
        step = { n: job.variants.length, status: 'running', ...task, directed, fixes, base: base?.n };
        job.variants.push(step);
        job.chain.step = ++made;
        this.changed();
        const input = base?.gen && fixes ? await revise(prep, base.gen, job.alpha!, job.mask!, fixes) : { prompt: prep.prompt, images: prep.images };
        if (signal.aborted) break;
        this.generations++;
        const res = await provider.generate({ ...input, aspectRatio: prep.frame.aspectRatio, imageSize: prep.imageSize, signal });
        const { gen, modelOutput } = await fitGenerated(prep, res.image);
        const stats = await measure(prep, gen, modelOutput);
        Object.assign(step, { gen, elapsedMs: res.elapsedMs, outsideChangedPct: stats.outsideChangedPct, insideChangedPct: stats.insideChangedPct, status: 'done' });
        // Новый шаг сразу на холсте, если пользователь, пока шли шаги, сам не выбрал другую версию
        if (!job.picked || job.variants[job.selected]?.status !== 'done') job.selected = step.n;
        await this.land(job, step, job.selected === step.n);
        job.status = 'done';
        base = step;
        step = undefined;
        this.changed();
      }
    } catch (err) {
      if (!signal.aborted) {
        if (step) Object.assign(step, { status: 'error', error: message(err) });
        job.error = step && steps > 1 ? `Шаг ${made}: ${message(err)}` : message(err);
      }
    } finally {
      // Остановленный шаг не нужен: это всегда последний вариант
      if (step?.status === 'running' && job.variants.at(-1) === step) job.variants.pop();
      job.chain = undefined;
      job.status = job.variants.some((v) => v.status === 'done') ? 'done' : 'error';
      if (job.status === 'error') job.error ??= 'Шаги остановлены';
      this.changed();
    }
  }

  /** Что критик говорит о варианте; тот же ответ при той же маске не спрашивается заново — если подходит («готово» не подходит, когда нужны замечания) */
  private async review(job: Job, prep: PreparedEdit, v: Variant, opts: { directed: string; mustFix: boolean; signal: AbortSignal }): Promise<Critique> {
    const { directed, mustFix, signal } = opts;
    const cached = v.critique;
    if (cached && cached.maskRev === job.maskRev && !(mustFix && cached.done)) return cached;
    if (!v.gen || !job.alpha || !job.mask) throw new Error('Вариант не готов');
    job.reviewing = true;
    this.changed();
    try {
      const maskRev = job.maskRev;
      const overview = await this.overview(job, prep);
      const res = await this.director().review({
        request: v.prompt,
        directed,
        style: job.style,
        hide: v.hide,
        fixes: v.fixes,
        mustFix,
        images: await criticImages(prep, blendFrame(prep, v.gen, job.alpha), job.mask, overview),
        sketch: prep.sketch.length > 0,
        overview: !!overview,
        references: prep.references.length,
        signal,
      });
      v.critique = { done: res.done, text: res.text, maskRev };
      return v.critique;
    } catch (err) {
      throw new Error(`Критик: ${message(err)}`);
    } finally {
      job.reviewing = false;
      this.changed();
    }
  }

  /** Весь холст с рамкой куска — директору и критику; null, если документ уже другой */
  private async overview(job: Job, prep: PreparedEdit): Promise<InputImage | undefined> {
    const doc = this.doc;
    return doc?.id === job.docId ? overviewImage(await doc.thumbnail(1024), prep.canvas, prep.frame.rect) : undefined;
  }

  /** Задача, как её расписал директор; для той же задачи и показа области — прежний текст без нового вызова */
  private async direct(job: Job, prep: PreparedEdit, task: { prompt: string; hide: boolean }): Promise<string> {
    const key = taskKey(task);
    if (job.directed?.key === key) return job.directed.text;
    job.directing = true;
    this.changed();
    try {
      const overview = await this.overview(job, prep);
      const res = await this.director().direct({
        request: task.prompt,
        style: job.style,
        hide: task.hide,
        images: await directorImages(prep, overview),
        sketch: prep.sketch.length > 0,
        overview: !!overview,
        references: prep.references.length,
        signal: job.abort.signal,
      });
      job.directed = { key, text: res.text };
      return res.text;
    } catch (err) {
      throw new Error(`Директор: ${message(err)}`);
    } finally {
      job.directing = false;
      this.changed();
    }
  }

  /** «Ещё варианты»: та же правка или с поправкой задачи, новые версии к уже имеющимся */
  async moreVariants(jobId: string, count: number, change: RedoChange = {}): Promise<void> {
    const job = this.job(jobId);
    const busy =
      job.status === 'running' || job.status === 'preparing' || job.status === 'queued' || !!job.chain || job.variants.some((v) => v.status === 'running');
    if (busy) throw new Error('Задача ещё идёт');
    if (!job.prep) return this.retry(jobId, change);
    const n = Math.min(Math.max(Math.round(count), 1), MAX_VARIANTS_PER_JOB - job.variants.length);
    if (n <= 0) throw new Error(`Не больше ${MAX_VARIANTS_PER_JOB} вариантов на правку`);
    const jump = redo(job, change);
    if (jump) job.picked = false;
    try {
      await this.generate(job, n, jump);
    } finally {
      this.changed();
    }
  }

  /** Задача с ошибкой: начать заново с подготовки куска, можно с поправкой задачи */
  retry(jobId: string, change: RedoChange = {}): void {
    const job = this.job(jobId);
    if (job.status !== 'error') throw new Error('Повторить можно только задачу с ошибкой');
    redo(job, change);
    job.abort = new AbortController();
    Object.assign(job, { status: 'queued', error: undefined, prep: undefined, mask: undefined, alpha: undefined, variants: [], selected: 0, picked: false });
    job.maskRev++;
    this.changed();
    this.schedule();
  }

  /** Остановить шаги с критиком: готовые варианты остаются, идущий шаг отменяется */
  stop(jobId: string): void {
    const job = this.job(jobId);
    if (!job.chain) return;
    job.abort.abort();
    job.abort = new AbortController();
  }

  /** Убрать задачу из очереди: идущая генерация отменяется, готовые варианты остаются версиями слоя */
  discard(jobId: string): void {
    const job = this.job(jobId);
    job.abort.abort();
    this.jobs = this.jobs.filter((j) => j !== job);
    this.changed();
    this.schedule();
  }

  /**
   * Готовый вариант — версией слоя задачи. Слоя нет (выделили не слой) — он появляется из выделения, с именем из задачи.
   * show — новая версия сразу текущая (если пользователь, пока шли варианты, сам не выбрал другую). У «Дорисовать фон»
   * вариант — версия заплатки фона под слоем. Маски слоев, чей край версия задела, пересчитываются следом
   */
  private land(job: Job, v: Variant, show: boolean): Promise<void> {
    return this.serialDoc((doc) => {
      if (doc.id !== job.docId || !v.gen || !job.prep || !job.alpha || !job.mask || v.patch) return;
      const patch: NewPatch = {
        id: randomUUID(),
        rect: job.prep.frame.inside,
        layer: buildLayer(job.prep, v.gen, job.alpha),
        mask: job.mask,
        feather: job.prep.feather,
        prompt: v.prompt,
        hide: v.hide,
        directed: v.directed,
        sketch: job.sketch.length ? job.sketch : undefined,
        jobId: job.id,
        variant: v.n,
        createdAt: new Date().toISOString(),
        model: job.model,
        size: job.size,
        refs: job.references,
      };
      if (job.detach) {
        v.patch = this.landFill(doc, job, patch, show);
        this.changed();
        return;
      }
      const existing = job.object ? doc.objects.find((o) => o.id === job.object) : undefined;
      const owner = existing ?? this.layerFromJob(doc, job);
      const region = patch.rect;
      const before = doc.region(region);
      let placed: string | undefined;
      doc.batch(() => {
        if (!existing) doc.setObjects(placeObject(doc.objects, owner));
        placed = doc.addPatch({ ...patch, object: owner.id }).id;
        if (show) doc.setObjects(doc.objects.map((o) => (o.id === owner.id ? { ...o, current: placed } : o)));
      });
      job.object = owner.id;
      v.patch = placed;
      this.changed();
      if (show) void this.followObjects(doc, placed!, region, before, doc.region(region));
    });
  }

  /** Новый слой из выделения задачи: имя — задача */
  private layerFromJob(doc: CanvasDocument, job: Job & { prep?: PreparedEdit }): DocObject {
    const bitmap = trim({ rect: job.prep!.frame.inside, mask: job.prep!.insideMask });
    if (!bitmap) throw new Error('Выделение пустое');
    return { id: randomUUID(), name: layerName(job.prompt), ...bitmap, createdAt: new Date().toISOString(), version: doc.nextObjectVersion(), edit: true };
  }

  /**
   * Вариант фона под слоем — версией его заплатки. Первый вариант снимает исходник слоя (пиксели холста без его текущей
   * версии, по маске чуть шире) и заводит заплатку; одним шагом отмены. Возвращает id версии
   */
  private landFill(doc: CanvasDocument, job: Job, patch: NewPatch, show: boolean): string {
    const obj = doc.objects.find((o) => o.id === job.detach);
    if (!obj) throw new Error('Слоя уже нет: дорисовывать фон не под чем');
    const existing = doc.objects.find((o) => o.kind === 'fill' && o.under === obj.id);
    let placed = '';
    doc.batch(() => {
      if (!liftedLayer(doc, obj.id)) this.lift(doc, obj, job.id);
      const fill: DocObject = existing ?? {
        id: randomUUID(),
        name: `Фон под «${obj.name}»`,
        kind: 'fill',
        under: obj.id,
        ...job.bitmaps.get(`obj:${obj.id}`)!,
        createdAt: new Date().toISOString(),
        version: doc.nextObjectVersion(),
      };
      if (!existing) doc.setObjects([...doc.objects, fill]);
      placed = doc.addPatch({ ...patch, object: fill.id }).id;
      if (show || !fill.current) doc.setObjects(doc.objects.map((o) => (o.id === fill.id ? { ...o, current: placed } : o)));
    });
    return placed;
  }

  /**
   * Снять исходник слоя: пиксели холста под его маской, чуть шире, чтобы контур не обрезался, — без его текущей версии.
   * Маска слоя с тех пор — маска этого исходника
   */
  private lift(doc: CanvasDocument, obj: DocObject, jobId: string): void {
    const { rect, mask } = dilate(obj, LIFT_GROW, { x: 0, y: 0, width: doc.width, height: doc.height });
    const rgb = obj.current ? doc.regionWithout(rect, obj.current) : doc.region(rect);
    const alpha = featherAlpha(mask, rect.width, rect.height, LIFT_FEATHER);
    const layer = Buffer.alloc(rect.width * rect.height * 4);
    for (let i = 0; i < alpha.length; i++) {
      rgb.copy(layer, i * 4, i * 3, i * 3 + 3);
      layer[i * 4 + 3] = Math.round(alpha[i]! * 255);
    }
    doc.addPatch({ id: randomUUID(), rect, layer, mask, feather: LIFT_FEATHER, prompt: obj.name, jobId, variant: 0, createdAt: new Date().toISOString(), object: obj.id, lifted: true });
    doc.setObjects(doc.objects.map((o) => (o.id === obj.id ? { ...o, rect, mask, version: doc.nextObjectVersion(), lost: undefined } : o)));
  }

  // ——— Слои ———

  /** Версия слоя на холсте; null — исходник. Шаг ⌘Z */
  setCurrent(objectId: string, patchId: string | null): Promise<void> {
    return this.serialDoc((doc) => {
      const obj = doc.object(objectId);
      if (patchId !== null) {
        const p = doc.patch(patchId);
        if (p.object !== objectId || p.lifted) throw new Error('Это не версия этого слоя');
      }
      if ((obj.current ?? null) === patchId) return;
      doc.setObjects(doc.objects.map((o) => (o.id === objectId ? { ...o, current: patchId ?? undefined } : o)));
      // Версию выбрали руками: новые варианты её не перебьют
      for (const j of this.jobs) {
        const v = j.variants.find((x) => x.patch === patchId);
        if (j.object === objectId) j.picked = true;
        if (v) j.selected = v.n;
      }
      this.changed();
    });
  }

  /** Скрыть слой или показать; с частями. Шаг ⌘Z */
  setHidden(objectId: string, hidden: boolean): Promise<void> {
    return this.serialDoc((doc) => {
      if (!!doc.object(objectId).hidden === hidden) return;
      doc.setObjects(doc.objects.map((o) => (o.id === objectId ? { ...o, hidden: hidden || undefined } : o)));
      this.changed();
    });
  }

  /** Добавить к маске версии то, что модель нарисовала за её краем: сравнивается с холстом без этой версии */
  expandVersion(patchId: string): Promise<number> {
    return this.serialDoc((doc) => {
      const p = doc.patch(patchId);
      const { width, height } = p.rect;
      const rgb = Buffer.alloc(width * height * 3);
      for (let i = 0; i < width * height; i++) p.layer.copy(rgb, i * 3, i * 4, i * 4 + 3);
      const rect = intersect(p.rect, { x: 0, y: 0, width: doc.width, height: doc.height });
      if (rect.width !== width || rect.height !== height) throw new Error('Версия выходит за край холста');
      const { mask, addedPx } = expandMaskByDiff(p.mask, doc.regionWithout(p.rect, p.id), rgb, width, height);
      if (addedPx > 0) doc.setPatchMask(p.id, mask);
      this.changed();
      return addedPx;
    });
  }

  /**
   * Маски объектов следуют за принятой правкой: те, чей край она задела, пересчитываются по новому холсту.
   * Это часть того же шага отмены: ⌘Z правки возвращает и прежние маски. Если пока считали, правку уже отменили
   * или скрыли, пересчёт не нужен; если после неё успели сделать что-то ещё — ложится отдельным шагом.
   */
  private async followObjects(doc: CanvasDocument, patchId: string, region: Rect, before: Buffer, after: Buffer): Promise<void> {
    // Маска отделённого объекта — маска его слоя, её не пересчитывают
    const objects = doc.objects.filter((o) => o.kind !== 'fill' && !liftedLayer(doc, o.id));
    if (!objects.length) return;
    const join = doc.historyTop();
    let masks: Map<string, Bitmap | null>;
    try {
      masks = await this.segmentation.remask(doc, objects, region, before, after);
    } catch {
      // Без пересчёта маски объектов просто остаются прежними
      return;
    }
    if (!masks.size) return;
    await this.serialDoc((d) => {
      if (d !== doc || !doc.hasPatch(patchId) || !doc.patch(patchId).active) return;
      const next = doc.objects.map((o): DocObject => {
        if (!masks.has(o.id)) return o;
        const b = masks.get(o.id);
        return b ? { ...o, rect: b.rect, mask: b.mask, version: doc.nextObjectVersion(), lost: undefined } : { ...o, lost: true };
      });
      doc.setObjects(next, { join });
      this.changed();
    });
  }

  // ——— Объекты ———

  /** Маска фигуры kind: 'mask': сохранённого объекта (obj:id) или объекта под щелчком */
  private maskOf(id: string): Bitmap {
    if (id.startsWith('obj:')) return this.requireDoc().object(id.slice(4));
    return this.segmentation.bitmap(id);
  }

  /** Картинка маски для браузера: белая там, где объект, не больше max по большей стороне */
  maskImage(id: string, max = 2048): Promise<Buffer> {
    return maskPng(this.maskOf(id), max);
  }

  /** Слой из выделения; слои внутри него становятся его частями, а он — частью того, в чём лежит */
  saveObject(input: MaskShape[], name?: string): Promise<string> {
    return this.serialDoc(async (doc) => {
      const bitmap = await this.selectionBitmap(doc, input);
      if (this.doc !== doc) throw new Error('Документ уже закрыт');
      const used = new Set(doc.objects.map((o) => o.name));
      let n = doc.objects.filter((o) => o.kind !== 'fill').length + 1;
      while (used.has(`Слой ${n}`)) n++;
      const obj: DocObject = {
        id: randomUUID(),
        name: name?.trim() || `Слой ${n}`,
        ...bitmap,
        createdAt: new Date().toISOString(),
        version: doc.nextObjectVersion(),
      };
      doc.setObjects(placeObject(doc.objects, obj));
      this.changed();
      return obj.id;
    });
  }

  renameObject(id: string, name: string): Promise<void> {
    return this.serialDoc((doc) => {
      const trimmed = name.trim();
      if (!trimmed) throw new Error('Пустое имя');
      if (doc.object(id).name === trimmed) return;
      doc.setObjects(doc.objects.map((o) => (o.id === id ? { ...o, name: trimmed } : o)));
      this.changed();
    });
  }

  /**
   * Удалить слой с его версиями. Неотделённый — на холсте снова исходник, его части переходят к его родителю.
   * Отделённый уходит с холста вместе с частями — под ним уже фон; заплатка фона — со своими версиями. ⌘Z возвращает
   */
  deleteObject(id: string): Promise<void> {
    return this.serialDoc((doc) => {
      const obj = doc.object(id);
      const whole = obj.kind === 'fill' || !!liftedLayer(doc, id);
      const gone = new Set(whole ? [id, ...descendants(doc.objects, id).map((o) => o.id)] : [id]);
      doc.batch(() => {
        for (const p of doc.patches.filter((x) => x.object && gone.has(x.object))) doc.removePatch(p.id);
        doc.setObjects(whole ? withoutTree(doc.objects, id) : removeObject(doc.objects, id));
      });
      this.changed();
    });
  }

  /**
   * Дорисовать фон под слоем: задача в очереди, где модель рисует то, что за ним, — область ей стирают, с запасом вокруг
   * контура. Первый готовый вариант снимает исходник слоя и заводит под ним заплатку фона; слой с тех пор можно сдвигать
   * и скрывать. Уже отделённому — ещё варианты заплатки
   */
  detachObject(objectId: string, req: DetachRequest): string {
    const doc = this.requireDoc();
    const obj = doc.object(objectId);
    if (obj.kind === 'fill') throw new Error('Это и есть фон');
    if (this.jobs.some((j) => j.detach === objectId && j.status !== 'done' && j.status !== 'error')) throw new Error('Фон под этим слоем уже рисуется');
    const grown = dilate(obj, fillGrow(obj.rect), { x: 0, y: 0, width: doc.width, height: doc.height });
    const id = `obj:${objectId}`;
    return this.enqueue({
      prompt: FILL_TASK,
      hide: true,
      model: req.model,
      size: req.size,
      variants: req.variants,
      shapes: [{ kind: 'mask', id, ...grown.rect }],
      bitmaps: new Map([[id, grown]]),
      object: objectId,
      detach: objectId,
      area: grown.rect,
      references: [],
      sketch: [],
      director: false,
    });
  }

  /**
   * Сдвинуть отделённый слой: все его версии и снятый исходник, его части с их версиями и маски — одним шагом отмены.
   * Всё сдвигаемое остаётся на холсте
   */
  moveObject(objectId: string, dx: number, dy: number): Promise<{ rev: number }> {
    return this.serialDoc((doc) => {
      if (!liftedLayer(doc, objectId)) throw new Error('Сначала дорисуйте фон под слоем');
      const moved = new Set([objectId, ...descendants(doc.objects, objectId).map((o) => o.id)]);
      const patches = doc.patches.filter((p) => p.object && moved.has(p.object));
      const all = patches.map((p) => p.rect).reduce(union);
      const sx = Math.min(Math.max(-all.x, Math.round(dx)), doc.width - all.x - all.width);
      const sy = Math.min(Math.max(-all.y, Math.round(dy)), doc.height - all.y - all.height);
      if (sx || sy) {
        const bounds = { x: 0, y: 0, width: doc.width, height: doc.height };
        doc.batch(() => {
          for (const p of patches) doc.movePatch(p.id, { ...p.rect, x: p.rect.x + sx, y: p.rect.y + sy });
          doc.setObjects(
            doc.objects.map((o) => {
              if (!moved.has(o.id)) return o;
              const b = shiftBitmap(o, sx, sy, bounds);
              return b ? { ...o, ...b, version: doc.nextObjectVersion() } : o;
            }),
          );
        });
      }
      this.changed();
      return { rev: doc.rev };
    });
  }

  /** Слой картинкой с растушёванной маской в альфе, не больше max по большей стороне: так сдвиг виден сразу */
  cutoutPng(patchId: string, max = 2048): Promise<Buffer> {
    const patch = this.requireDoc().patch(patchId);
    const { width, height } = patch.rect;
    const k = Math.min(1, max / Math.max(width, height));
    let img = sharp(Buffer.from(patch.layer), { raw: { width, height, channels: 4 } });
    if (k < 1) img = img.resize(Math.max(1, Math.round(width * k)), Math.max(1, Math.round(height * k)), { fit: 'fill' });
    return img.png({ compressionLevel: 2 }).toBuffer();
  }

  // ——— Выделение объектов ———

  installSegmenter(): void {
    this.segmentation.install();
  }

  prepareView(view: RectDto): Promise<void> {
    return this.segmentation.prepare(this.requireDoc(), view);
  }

  hoverObject(view: RectDto, x: number, y: number): Promise<{ png: Buffer; rect: RectDto } | null> {
    return this.segmentation.hover(this.requireDoc(), view, x, y);
  }

  async pickObject(req: PickRequest): Promise<PickResult> {
    const doc = this.requireDoc();
    // Выделение, к которому объект добавят или из которого вычтут; устаревшее — просто без него
    const selection = req.op && req.op !== 'new' && req.selection?.length ? await this.selectionBitmap(doc, req.selection).catch(() => undefined) : undefined;
    return this.segmentation.pick(doc, req, selection);
  }

  refineObject(id: string, snap = false): Promise<MaskResult> {
    return this.segmentation.refine(this.requireDoc(), id, snap);
  }

  /** Выделение одной маской, обрезанной по выделенному */
  private async selectionBitmap(doc: CanvasDocument, input: MaskShape[]): Promise<Bitmap> {
    const { shapes, bitmaps } = this.resolveShapes(input);
    const box = shapesBBox(shapes);
    const area = box && intersect(box, { x: 0, y: 0, width: doc.width, height: doc.height });
    if (!area?.width || !area.height) throw new Error('Нет выделения');
    const mask = await applyShapes(new Uint8Array(area.width * area.height), area, shapes, (id) => bitmaps.get(id)!);
    const bitmap = trim({ rect: area, mask });
    if (!bitmap) throw new Error('Выделение пустое');
    return bitmap;
  }

  /** «Палочка»: область вокруг точки той же яркости в видимой части холста — маской выделения */
  wandSelect(req: WandRequest): MaskResult {
    const doc = this.requireDoc();
    const view = intersect(req.view, { x: 0, y: 0, width: doc.width, height: doc.height });
    if (view.width < 1 || view.height < 1) throw new Error('Вид за краем холста');
    const b = wand(doc.region(view), view, [req.x, req.y], req);
    if (!b) throw new Error('Здесь ничего не выделилось');
    return this.segmentation.keep(b);
  }

  /** Край всего выделения шире или уже на px — одной маской */
  async selectionEdge(req: EdgeRequest): Promise<MaskResult> {
    const doc = this.requireDoc();
    const px = Math.max(-200, Math.min(200, Math.round(req.px)));
    const b = changeEdge(await this.selectionBitmap(doc, req.shapes), px, { x: 0, y: 0, width: doc.width, height: doc.height });
    if (!b) throw new Error('Выделение сузилось в ничто');
    return this.segmentation.keep(b);
  }

  /** Мазок кисти, привязанный к линиям рисунка: клетки штриховки, которые он задел, — целиком, с контуром */
  async snapSelection(req: SnapRequest): Promise<MaskResult> {
    const doc = this.requireDoc();
    const b = await this.selectionBitmap(doc, req.shapes);
    return this.segmentation.keep(this.segmentation.snap(doc, [b], Math.max(0, Math.min(400, req.reach)))[0]!);
  }
}

/** Слой отделённого объекта; нет — объект не отделён */
function liftedLayer(doc: CanvasDocument, objectId: string): Patch | undefined {
  return doc.patches.findLast((p) => p.lifted && p.object === objectId);
}

/** Без объекта и всех его частей: так уходит отделённый объект вместе со своим слоем */
function withoutTree(objects: DocObject[], id: string): DocObject[] {
  const gone = new Set([id, ...descendants(objects, id).map((o) => o.id)]);
  return objects.filter((o) => !gone.has(o.id));
}

/** Маска, сдвинутая на dx, dy и обрезанная по холсту; null — вся ушла за край */
function shiftBitmap(b: Bitmap, dx: number, dy: number, bounds: Rect): Bitmap | null {
  const rect = { ...b.rect, x: b.rect.x + dx, y: b.rect.y + dy };
  const o = intersect(rect, bounds);
  if (o.width === rect.width && o.height === rect.height) return { rect, mask: b.mask };
  if (!o.width || !o.height) return null;
  const mask = new Uint8Array(o.width * o.height);
  for (let y = 0; y < o.height; y++) {
    const from = (o.y - rect.y + y) * rect.width + o.x - rect.x;
    mask.set(b.mask.subarray(from, from + o.width), y * o.width);
  }
  return trim({ rect: o, mask });
}

function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

/** Как показать модели область: стереть, что под маской, или подсветить её поверх куска */
function guideOf(hide: boolean): Guide {
  return hide ? 'blank' : 'pair';
}

/** Что директор получил на вход, кроме картинок: та же задача и показ области — тот же его текст */
function taskKey(task: { prompt: string; hide: boolean }): string {
  return `${task.hide}:${task.prompt}`;
}

/** Поправка задачи перед повтором; true — что-то поменялось */
function redo(job: Job, change: RedoChange): boolean {
  const before = `${job.director}:${taskKey(job)}`;
  const prompt = change.prompt?.trim();
  if (prompt) job.prompt = prompt;
  if (change.hide !== undefined) job.hide = change.hide;
  if (change.director !== undefined) job.director = !!change.director;
  return `${job.director}:${taskKey(job)}` !== before;
}

/** Маска слоя одним каналом на его месте на холсте — так её принимает prepareEdit */
function layerMask({ mask, rect }: Replaced): RawImage & { x: number; y: number } {
  return { data: Buffer.from(mask.buffer, mask.byteOffset, mask.length), width: rect.width, height: rect.height, channels: 1, x: rect.x, y: rect.y };
}
