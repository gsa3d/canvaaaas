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
  applyLayer,
  blendFrame,
  buildLayer,
  criticImages,
  DEFAULT_FEATHER,
  directorImages,
  fitGenerated,
  insideOf,
  layerAsGen,
  layerOver,
  measure,
  type MaskedLayer,
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
import { featherAlpha, featherAlphaRegion, MASK_THRESHOLD, maskBBox } from '../core/mask.ts';
import { applyShapes, applyShapesRegion, type MaskLookup } from '../core/mask-shapes.ts';
import { changeEdge } from '../core/lines.ts';
import { area, descendants, dilate, layerName, overlap, removeObject, trim, unionBitmap } from '../core/objects.ts';
import type { Bitmap } from '../core/segment.ts';
import type { KeyStore } from '../core/secrets.ts';
import { checkSketch } from '../core/sketch.ts';
import { chatgptCodex, chatgptDirector, findCodex } from '../providers/chatgpt-codex.ts';
import { mockDirector, type PromptDirector } from '../providers/director.ts';
import { laozhangGemini } from '../providers/laozhang-gemini.ts';
import { mockProvider } from '../providers/mock.ts';
import type { ImageProvider, InputImage } from '../providers/types.ts';
import { maskPng, Segmentation, type Scope } from './segmentation.ts';
import {
  MAX_REFERENCES,
  OUTSIDE_LAYER,
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
/** Подсветка слоя под курсором — не больше этого по большей стороне, как у объекта под курсором */
const HOVER_LAYER_MAX = 1600;
const LIFT_FEATHER = 2;

/**
 * Насколько шире слоя модель дорисовывает фон под ним: растушёвка вклейки и ещё запас, иначе на контуре слоя дорисованное
 * лежит не целиком и старый контур просвечивает
 */
function fillGrow(rect: Rect): number {
  return DEFAULT_FEATHER + Math.min(40, Math.max(6, Math.round(0.02 * Math.max(rect.width, rect.height))));
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
  /** Слой, в который ложатся версии: работают в слое — он; иначе слой появится из выделения с первым готовым вариантом */
  object?: string;
  /**
   * Версия слоя, которую видела модель, — та, что была видна, когда кусок ушёл модели. Правка части слоя ложится
   * поверх неё: остальное остаётся от неё
   */
  base?: string;
  /**
   * Перерисовывают весь слой: варианты его заменяют, base в них не копируется — иначе её край просвечивал бы сквозь
   * растушёвку, и ни кисть, ни «Расширить по правке» его уже не убрали бы. Не задано — решает, весь ли слой в выделении
   */
  whole?: boolean;
  /**
   * По чему растёт слой, когда маска задачи шире выделения (кольцо у перерисовки всего слоя, `ringed`): что выделил
   * пользователь; null — слой не растёт. Не задано — по маске задачи
   */
  claim?: Bitmap | null;
  /** Фон под этим слоем: вариант ложится версией слоя с дырой под ним (object) или новым слоем в самом низу (bottom) */
  fillFor?: string;
  bottom?: boolean;
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
        baseState: doc.baseState,
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
        fillFor: j.fillFor,
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
        critique: p.critique,
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
        freed: o.freed || doc!.objects.some((f) => f.kind === 'fill' && f.under === o.id) || undefined,
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
   * Мазок ложится прямо в прозрачность версии (bakeMask): его край — какой задала мягкость кисти.
   * Пересчитывается только участок около мазка, поэтому холст догоняет кисть быстро и на большом слое.
   */
  editPatchMask(patchId: string, shapes: MaskShape[]): Promise<MaskEditResult> {
    return this.serialDoc(async (doc) => {
      const patch = doc.patch(patchId);
      doc.bakeMask(patchId);
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
   * версии над ней, ответ модели на весь кусок и маска — в размере превью. Маска — прозрачность версии, как её
   * правит кисть (bakeMask), поэтому браузер не растушёвывает её. version — чья маска в картинке.
   */
  async maskEditImage(patchId: string, part: string): Promise<{ data: Buffer; type: string; version: number }> {
    const doc = this.requireDoc();
    const patch = doc.patch(patchId);
    const { rect, maskVersion: version } = patch;
    const mask = new Uint8Array(rect.width * rect.height);
    for (let i = 0; i < mask.length; i++) mask[i] = patch.layer[i * 4 + 3]!;
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
    const { object } = req;
    if (object) {
      const o = this.requireDoc().objects.find((x) => x.id === object);
      if (!o) throw new Error('Слоя уже нет: выберите другой');
      if (o.hidden) throw new Error(`Слой «${o.name}» скрыт: покажите его`);
    }
    const refIds = req.refs ?? [];
    if (refIds.length > MAX_REFERENCES) throw new Error(`Не больше ${MAX_REFERENCES} референсов на правку`);
    const references = refIds.map((id) => {
      const ref = this.references.get(id);
      if (!ref) throw new Error('Референс не найден — добавьте картинку заново');
      return ref.image;
    });
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
    const doc = this.requireDoc();
    const patch = doc.patch(patchId);
    if (patch.lifted) throw new Error('Исходник перерисовывают правкой: выделите слой и напишите задачу');
    // Модель снова видит прежнюю версию слоя; у правки части слоя перерисовывается только сама правка поверх неё
    const base = patch.base && doc.hasPatch(patch.base) ? patch.base : undefined;
    // Маска, правленная рукой, — прозрачность версии (растушёвка 0): новым вариантам — что видно больше чем наполовину,
    // и растушёвка вклейки как у генерации
    const mask = base && patch.part ? patch.part : patch.feather ? patch.mask : patch.mask.map((v) => (v >= MASK_THRESHOLD ? 255 : 0));
    const feather = patch.feather || DEFAULT_FEATHER;
    // Версия всего слоя — и новые его заменяют; так же правка из прежних версий, накрывшая слой целиком
    const owner = patch.object ? doc.objects.find((o) => o.id === patch.object) : undefined;
    const whole = !patch.part || (!!owner && overlap(owner, { rect: patch.rect, mask: patch.part }) === area(owner));
    const box = maskBBox(mask, patch.rect.width, patch.rect.height);
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
      base,
      whole,
      from: { patchId, mask, rect: patch.rect, feather },
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
      | 'fillFor'
      | 'bottom'
      | 'area'
      | 'references'
      | 'sketch'
      | 'director'
      | 'directed'
      | 'base'
      | 'whole'
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
      const mask = ringed(doc, job, from ? layerMask(from) : await this.rasterize(job, doc), from?.feather ?? DEFAULT_FEATHER);
      // Правка слоя: модель видит холст с его видимой версией, варианты лягут поверх неё
      if (!from && job.object) job.base = visibleVersion(doc, job.object);
      const base = job.base && doc.hasPatch(job.base) ? doc.patch(job.base) : undefined;
      const prep = await prepareEdit({
        image: doc.raw(),
        mask,
        // «Ещё варианты» версии: холст без неё, а у правки части слоя — с прежней версией на её месте
        crop: current ? (inside) => (base ? doc.regionReplaced(inside, current.id, base.rect, base.layer) : doc.regionWithout(inside, current.id)) : undefined,
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
      // Замечания остаются и у версии: законченная задача из списка уходит, версия — нет
      if (v.patch && this.doc?.hasPatch(v.patch)) this.doc.patch(v.patch).critique = { done: res.done, text: res.text };
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
      const existing = job.object ? doc.objects.find((o) => o.id === job.object) : undefined;
      const freed = job.fillFor ? doc.objects.find((o) => o.id === job.fillFor) : undefined;
      // Фон, под которым нет других слоёв, — новым слоем в самом низу, с именем того, под кем он
      const owner = existing ?? { ...this.layerFromJob(doc, job), ...(freed ? { name: `Фон под «${freed.name}»` } : {}) };
      const edited = trim({ rect: job.prep.frame.inside, mask: job.mask });
      // Правка части слоя ложится поверх версии, которую модель видела: остальной слой остаётся от неё.
      // Весь слой в выделении — версия его заменяет: прежняя в неё не копируется, но помнится для «Ещё вариантов»
      const below = existing && job.base && doc.hasPatch(job.base) ? doc.patch(job.base) : undefined;
      const whole = job.whole ?? (!!existing && !!edited && overlap(existing, edited) === area(existing));
      const over = below && !whole ? layerOver(below, { rect: patch.rect, layer: patch.layer, mask: job.mask }) : undefined;
      const version: NewPatch = over ? { ...patch, rect: over.rect, layer: over.layer, mask: over.mask, base: below!.id, part: over.part } : { ...patch, base: below?.id };
      // Выделение за краем слоя — слой растёт; кольцо у перерисовки всего слоя — не выделение
      const claimed = job.claim === undefined ? edited : job.claim;
      const grown = existing && existing.kind !== 'fill' && claimed && overlap(claimed, existing) < area(claimed) ? trim(unionBitmap(existing, claimed)) : null;
      const region = version.rect;
      const before = doc.region(region);
      let placed: string | undefined;
      doc.batch(() => {
        // Новый слой — сверху (фон — в самом низу), остальные не трогаются
        if (!existing) doc.setObjects(job.bottom ? [owner, ...doc.objects] : [...doc.objects, owner]);
        if (freed && !freed.freed) doc.setObjects(doc.objects.map((o) => (o.id === freed.id ? { ...o, freed: true } : o)));
        if (grown) doc.setObjects(doc.objects.map((o) => (o.id === owner.id ? { ...o, ...grown, version: doc.nextObjectVersion(), lost: undefined } : o)));
        placed = doc.addPatch({ ...version, object: owner.id }).id;
        if (show) doc.setObjects(doc.objects.map((o) => (o.id === owner.id ? { ...o, current: placed } : o)));
      });
      job.object = owner.id;
      v.patch = placed;
      this.changed();
    });
  }

  /** Новый слой из выделения задачи: имя — задача */
  private layerFromJob(doc: CanvasDocument, job: Job & { prep?: PreparedEdit }): DocObject {
    const bitmap = trim({ rect: job.prep!.frame.inside, mask: job.prep!.insideMask });
    if (!bitmap) throw new Error('Выделение пустое');
    return { id: randomUUID(), name: layerName(job.prompt), ...bitmap, createdAt: new Date().toISOString(), version: doc.nextObjectVersion(), edit: true };
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

  /**
   * Добавить к маске версии то, что модель нарисовала за её краем: сравнивается с холстом без этой версии,
   * а у правки части слоя — с прежней версией на её месте. К краю куска, за которым холст продолжается, маска
   * вплотную не подходит: там вклейка оборвалась бы без растушёвки
   */
  expandVersion(patchId: string): Promise<number> {
    return this.serialDoc((doc) => {
      const p = doc.patch(patchId);
      const { width, height } = p.rect;
      const rgb = Buffer.alloc(width * height * 3);
      for (let i = 0; i < width * height; i++) p.layer.copy(rgb, i * 3, i * 4, i * 4 + 3);
      const rect = intersect(p.rect, { x: 0, y: 0, width: doc.width, height: doc.height });
      if (rect.width !== width || rect.height !== height) throw new Error('Версия выходит за край холста');
      const base = p.base && p.part && doc.hasPatch(p.base) ? doc.patch(p.base) : undefined;
      const under = base ? doc.regionReplaced(p.rect, p.id, base.rect, base.layer) : doc.regionWithout(p.rect, p.id);
      const closed = { left: rect.x > 0, top: rect.y > 0, right: rect.x + width < doc.width, bottom: rect.y + height < doc.height };
      const { mask, addedPx } = expandMaskByDiff(p.mask, under, rgb, width, height, { closed });
      if (addedPx > 0) {
        // Маска, правленная рукой, — сама прозрачность: добавленное растушёвываем здесь, как растушевала бы вклейка
        if (p.feather) doc.setPatchMask(p.id, mask);
        else {
          const alpha = featherAlpha(mask.map((v) => (v >= MASK_THRESHOLD ? 255 : 0)), width, height, DEFAULT_FEATHER);
          doc.setPatchMask(p.id, p.mask.map((v, i) => Math.max(v, Math.round(alpha[i]! * 255))));
        }
      }
      this.changed();
      return addedPx;
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

  /**
   * Слой из выделения: копия того, что сейчас видно под ним, — своими пикселями, сверху всех. Другие слои не трогаются;
   * правки под ним его больше не меняют. Одним шагом ⌘Z
   */
  saveObject(input: MaskShape[], name?: string): Promise<string> {
    return this.serialDoc(async (doc) => {
      const bitmap = await this.selectionBitmap(doc, input);
      if (this.doc !== doc) throw new Error('Документ уже закрыт');
      const obj: DocObject = {
        id: randomUUID(),
        name: name?.trim() || nextLayerName(doc),
        ...bitmap,
        createdAt: new Date().toISOString(),
        version: doc.nextObjectVersion(),
      };
      doc.batch(() => {
        doc.setObjects([...doc.objects, obj]);
        this.lift(doc, obj, `copy:${obj.id}`);
      });
      this.changed();
      return obj.id;
    });
  }

  /**
   * Вырезать в слой: копия того, что видно в выделении, новым слоем сверху, а на старом месте — дыра у того, чьи пиксели
   * там видны: в слое — его версия теряет этот кусок (область слоя прежняя, дыра — его), в фоне — белое место. Копия
   * шире дыры на контур, поэтому, пока слой на месте, картинка та же. Генерации нет. Одним шагом ⌘Z
   */
  cutObject(input: MaskShape[], name?: string): Promise<string> {
    return this.serialDoc(async (doc) => {
      const hole = await this.selectionBitmap(doc, input);
      if (this.doc !== doc) throw new Error('Документ уже закрыт');
      const obj: DocObject = { id: randomUUID(), name: name?.trim() || nextLayerName(doc), ...hole, createdAt: new Date().toISOString(), version: doc.nextObjectVersion(), freed: true, hole };
      // Чей каждый пиксель дыры: верхней видимой версии слоя, где он непрозрачен, иначе фона
      const order = doc.drawOrder().filter((p) => p.object).reverse();
      const claims = new Map<string | null, Uint8Array>();
      const { rect } = hole;
      for (let y = 0; y < rect.height; y++) {
        for (let x = 0; x < rect.width; x++) {
          const i = y * rect.width + x;
          if (hole.mask[i]! < MASK_THRESHOLD) continue;
          const cx = rect.x + x;
          const cy = rect.y + y;
          const p = order.find((q) => cx >= q.rect.x && cy >= q.rect.y && cx < q.rect.x + q.rect.width && cy < q.rect.y + q.rect.height && q.layer[((cy - q.rect.y) * q.rect.width + cx - q.rect.x) * 4 + 3]! >= MASK_THRESHOLD);
          const key = p?.id ?? null;
          let claim = claims.get(key);
          if (!claim) claims.set(key, (claim = new Uint8Array(rect.width * rect.height)));
          claim[i] = 255;
        }
      }
      doc.batch(() => {
        // Сначала копия — того, что видно сейчас, с дырами ещё нет
        doc.setObjects([...doc.objects, obj]);
        this.lift(doc, obj, `cut:${obj.id}`);
        for (const [patchId, claim] of claims) {
          if (patchId === null) {
            const b = trim({ rect, mask: claim })!;
            const rgb = Buffer.alloc(b.rect.width * b.rect.height * 3);
            for (let y = 0; y < b.rect.height; y++) {
              const from = ((b.rect.y + y) * doc.width + b.rect.x) * 3;
              doc.base.copy(rgb, y * b.rect.width * 3, from, from + b.rect.width * 3);
              for (let x = 0; x < b.rect.width; x++) if (b.mask[y * b.rect.width + x]) rgb.fill(255, (y * b.rect.width + x) * 3, (y * b.rect.width + x) * 3 + 3);
            }
            doc.setBase(b.rect, rgb);
            continue;
          }
          const p = doc.patch(patchId);
          const mask = new Uint8Array(p.mask);
          const r = intersect(p.rect, rect);
          for (let y = r.y; y < r.y + r.height; y++) {
            for (let x = r.x; x < r.x + r.width; x++) if (claim[(y - rect.y) * rect.width + x - rect.x]) mask[(y - p.rect.y) * p.rect.width + x - p.rect.x] = 0;
          }
          doc.setPatchMask(patchId, mask);
        }
      });
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
   * Влить слой в фон: то, что от него видно (с заплаткой фона под ним), ложится в исходник, слой и все его версии уходят.
   * Если под ним видны другие слои, нельзя: в исходнике он оказался бы под ними. Одним шагом ⌘Z
   */
  mergeIntoBase(objectId: string): Promise<void> {
    return this.serialDoc((doc) => {
      const obj = doc.object(objectId);
      if (obj.hidden) throw new Error(`Слой «${obj.name}» скрыт: покажите его или удалите`);
      // Слой, его части (из старых проектов) и заплатки фона под ними
      const group = new Set([objectId, ...descendants(doc.objects, objectId).map((o) => o.id)]);
      for (const f of doc.objects) if (f.kind === 'fill' && f.under && group.has(f.under)) group.add(f.id);
      const order = doc.drawOrder();
      const mine = order.filter((p) => p.object && group.has(p.object));
      const top = order.lastIndexOf(mine.at(-1)!);
      const under = order.slice(0, Math.max(0, top)).filter((p) => !(p.object && group.has(p.object)) && mine.some((m) => layersOverlap(p, m)));
      if (under.length) {
        const names = [...new Set(under.flatMap((p) => (p.object ? [doc.object(p.object).name] : [])))].map((n) => `«${n}»`);
        throw new Error(names.length ? `Под слоем видны ${names.join(', ')}: сначала влейте их или объедините с ним` : 'Под слоем видны другие правки');
      }
      doc.batch(() => {
        if (mine.length) {
          const rect = mine.map((p) => intersect(p.rect, { x: 0, y: 0, width: doc.width, height: doc.height })).reduce(union);
          const region = { data: Buffer.alloc(rect.width * rect.height * 3), rect, channels: 3 as const };
          for (let row = 0; row < rect.height; row++) {
            const from = ((rect.y + row) * doc.width + rect.x) * 3;
            doc.base.copy(region.data, row * rect.width * 3, from, from + rect.width * 3);
          }
          for (const p of mine) applyLayer(region, p.rect, p.layer);
          doc.setBase(rect, region.data);
        }
        doc.removePatches(doc.patches.filter((p) => p.object && group.has(p.object)).map((p) => p.id));
        doc.setObjects(doc.objects.filter((o) => !group.has(o.id)).map((o) => (o.parent && group.has(o.parent) ? { ...o, parent: undefined } : o)));
      });
      this.changed();
    });
  }

  /**
   * Объединить слои в один: то, что сейчас видно от каждого, — одной картинкой, версии уходят. Новый слой встаёт на место
   * верхнего из них и берёт его имя; заплатки фона под ними остаются — под ним. Одним шагом ⌘Z. Возвращает id
   */
  mergeLayers(ids: string[]): Promise<string> {
    return this.serialDoc((doc) => {
      const picked = [...new Set(ids)].map((id) => doc.object(id)).filter((o) => o.kind !== 'fill' && !o.hidden);
      if (picked.length < 2) throw new Error('Объединяют два видимых слоя или больше');
      const group = new Set(picked.flatMap((o) => [o.id, ...descendants(doc.objects, o.id).map((d) => d.id)]));
      const mine = doc.drawOrder().filter((p) => p.object && group.has(p.object));
      if (!mine.length) throw new Error('В этих слоях нечего объединять: у них нет своих пикселей');
      let acc: MaskedLayer = mine[0]!;
      for (const p of mine.slice(1)) acc = layerOver(acc, p);
      const shape = trim({ rect: acc.rect, mask: acc.mask });
      if (!shape) throw new Error('В этих слоях нечего объединять');
      // Верхний — тот, чья версия рисуется последней; его место и имя
      const top = doc.object(mine.at(-1)!.object!);
      const topId = top.parent && group.has(top.parent) ? picked.find((o) => o.id === top.parent)?.id ?? top.id : top.id;
      const merged: DocObject = { id: randomUUID(), name: doc.object(topId).name, ...shape, createdAt: new Date().toISOString(), version: doc.nextObjectVersion() };
      const next = doc.objects.flatMap((o): DocObject[] => {
        if (o.id === topId) return [merged];
        if (group.has(o.id)) return [];
        if (o.kind === 'fill' && o.under && group.has(o.under)) return [{ ...o, under: merged.id }];
        return [o.parent && group.has(o.parent) ? { ...o, parent: undefined } : o];
      });
      doc.batch(() => {
        doc.removePatches(doc.patches.filter((p) => p.object && group.has(p.object)).map((p) => p.id));
        doc.setObjects(next);
        doc.addPatch({ id: randomUUID(), ...acc, feather: LIFT_FEATHER, prompt: merged.name, jobId: `merge:${merged.id}`, variant: 0, createdAt: merged.createdAt, object: merged.id, lifted: true });
      });
      this.changed();
      return merged.id;
    });
  }

  /** Свести все слои: то, что видно, становится исходником, слои (и скрытые) и их версии уходят. Одним шагом ⌘Z */
  flattenLayers(): Promise<void> {
    return this.serialDoc((doc) => {
      if (!doc.objects.length && !doc.patches.length) throw new Error('Слоёв нет: сводить нечего');
      const order = doc.drawOrder();
      doc.batch(() => {
        if (order.length) {
          const rect = order.map((p) => intersect(p.rect, { x: 0, y: 0, width: doc.width, height: doc.height })).reduce(union);
          doc.setBase(rect, doc.region(rect));
        }
        doc.removePatches(doc.patches.map((p) => p.id));
        doc.setObjects([]);
      });
      this.changed();
    });
  }

  /**
   * Дорисовать фон под слоем — там, где дыра: у вырезанного — откуда его вырезали, у остальных — под ним сейчас. В каждом
   * слое под ним, чья маска накрывает это место (с запасом на растушёвку, чтобы контур не просвечивал), — версией этого
   * слоя, по задаче на слой; где там только фон — новым слоем в самом низу. Модели область стирают, и она продолжает то,
   * что вокруг. Возвращает id задач
   */
  fillUnder(objectId: string, req: DetachRequest): string[] {
    const doc = this.requireDoc();
    const obj = doc.object(objectId);
    if (obj.kind === 'fill') throw new Error('Это и есть фон');
    if (this.jobs.some((j) => j.fillFor === objectId && j.status !== 'done' && j.status !== 'error')) throw new Error('Фон под этим слоем уже рисуется');
    const place = obj.hole ?? obj;
    const region = dilate(place, fillGrow(place.rect), { x: 0, y: 0, width: doc.width, height: doc.height });
    // Чья каждая точка под слоем: верхнего из слоёв под ним, чья маска её накрывает, иначе фона
    const below = doc.layersBelow(objectId);
    const claims = new Map<string | null, Uint8Array>();
    const { rect } = region;
    for (let y = 0; y < rect.height; y++) {
      for (let x = 0; x < rect.width; x++) {
        const i = y * rect.width + x;
        if (region.mask[i]! < MASK_THRESHOLD) continue;
        const owner = below.find((o) => covers(o, rect.x + x, rect.y + y))?.id ?? null;
        let claim = claims.get(owner);
        if (!claim) claims.set(owner, (claim = new Uint8Array(rect.width * rect.height)));
        claim[i] = 255;
      }
    }
    // Дорисовывают только те, у кого есть часть самой дыры; запас вокруг неё у остальных — главному из них (он подрастёт):
    // иначе на границе с ними дорисованное опять лежало бы не целиком
    const share = new Map<string | null, number>();
    for (const [owner, claim] of claims) {
      let n = 0;
      for (let y = 0; y < rect.height; y++) {
        for (let x = 0; x < rect.width; x++) if (claim[y * rect.width + x] && covers(place, rect.x + x, rect.y + y)) n++;
      }
      share.set(owner, n);
    }
    const main = [...share].reduce((a, b) => (b[1] > a[1] ? b : a))[0];
    for (const [owner, claim] of claims) {
      if (share.get(owner)! > 0 || owner === main) continue;
      const to = claims.get(main)!;
      for (let i = 0; i < claim.length; i++) if (claim[i]) to[i] = 255;
      claims.delete(owner);
    }
    return [...claims].flatMap(([owner, mask]) => {
      const b = trim({ rect, mask });
      if (!b) return [];
      const id = `fill:${randomUUID()}`;
      return [
        this.enqueue({
          prompt: FILL_TASK,
          hide: true,
          model: req.model,
          size: req.size,
          variants: req.variants,
          shapes: [{ kind: 'mask', id, ...b.rect }],
          bitmaps: new Map([[id, b]]),
          object: owner ?? undefined,
          fillFor: objectId,
          bottom: owner === null || undefined,
          area: b.rect,
          references: [],
          sketch: [],
          director: false,
        }),
      ];
    });
  }

  /**
   * Сдвинуть отделённый слой: все его версии и снятый исходник, его части с их версиями и маски — одним шагом отмены.
   * Всё сдвигаемое остаётся на холсте
   */
  moveObject(objectId: string, dx: number, dy: number): Promise<{ rev: number }> {
    return this.serialDoc((doc) => {
      const obj = doc.object(objectId);
      if (obj.kind === 'fill') throw new Error('Заплатка фона лежит на месте: сдвигают её слой');
      if (!liftedLayer(doc, objectId) && !obj.current) throw new Error('В слое нечего сдвигать: у него нет своих пикселей');
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

  /** Миниатюра версии для панели слоёв: то, что от неё видно (по рамке маски), вписанное в size×size, вокруг прозрачно */
  thumbPng(patchId: string, size = 72): Promise<Buffer> {
    const patch = this.requireDoc().patch(patchId);
    const { width, height } = patch.rect;
    const box = maskBBox(patch.mask, width, height) ?? { x: 0, y: 0, width, height };
    return sharp(Buffer.from(patch.layer), { raw: { width, height, channels: 4 } })
      .extract({ left: box.x, top: box.y, width: box.width, height: box.height })
      .resize(size, size, { fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 2 })
      .toBuffer();
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

  /**
   * Подсветка под курсором — то, что выделит щелчок: в слое, где работают, или на фоне — объект только там,
   * над другим слоем — весь этот слой. within — слой, в котором работают
   */
  async hoverObject(view: RectDto, x: number, y: number, within?: string): Promise<{ png: Buffer; rect: RectDto } | null> {
    const doc = this.requireDoc();
    const owner = doc.layerAt(x, y);
    if (owner && owner.id !== within) return { png: await maskPng(owner, HOVER_LAYER_MAX), rect: owner.rect };
    return this.segmentation.hover(doc, view, x, y, scopeOf(doc, owner));
  }

  /**
   * Щелчок палочкой. Чей пиксель под ним — верхнего видимого слоя или фона: объект ищется только там, поэтому
   * объекты разных слоёв в одно выделение не попадают. Щелчок по другому слою — вход в него, без модели.
   * Добавить и вычесть — только там же, где работают (в слое within или на фоне); рамка — тоже
   */
  async pickObject(req: PickRequest): Promise<PickResult> {
    const doc = this.requireDoc();
    const active = req.within ? doc.objects.find((o) => o.id === req.within && o.kind !== 'fill') : undefined;
    const point = req.points?.find((p) => p.positive);
    const changing = req.op === 'add' || req.op === 'sub';
    const owner = point && !req.box ? doc.layerAt(point.x, point.y) : (active ?? null);
    if (changing && (owner?.id ?? null) !== (active?.id ?? null)) throw new Error(OUTSIDE_LAYER);
    if (owner && owner.id !== active?.id) return { levels: [{ id: `obj:${owner.id}`, rect: owner.rect }], level: 0, owner: owner.id, enter: true };
    // Выделение, к которому объект добавят или из которого вычтут; устаревшее — просто без него
    const selection = changing && req.selection?.length ? await this.selectionBitmap(doc, req.selection).catch(() => undefined) : undefined;
    const res = await this.segmentation.pick(doc, req, selection, scopeOf(doc, owner));
    return { ...res, owner: owner?.id ?? null };
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

/** «Слой N» со следующим свободным номером */
function nextLayerName(doc: CanvasDocument): string {
  const used = new Set(doc.objects.map((o) => o.name));
  let n = doc.objects.filter((o) => o.kind !== 'fill').length + 1;
  while (used.has(`Слой ${n}`)) n++;
  return `Слой ${n}`;
}

/** Точка холста внутри маски */
function covers(b: Bitmap, x: number, y: number): boolean {
  const lx = x - b.rect.x;
  const ly = y - b.rect.y;
  return lx >= 0 && ly >= 0 && lx < b.rect.width && ly < b.rect.height && b.mask[ly * b.rect.width + lx]! >= MASK_THRESHOLD;
}

/** Видны ли где-то обе версии разом: пиксели, где у обеих есть альфа */
function layersOverlap(a: Patch, b: Patch): boolean {
  const r = intersect(a.rect, b.rect);
  for (let y = r.y; y < r.y + r.height; y++) {
    for (let x = r.x; x < r.x + r.width; x++) {
      if (a.layer[((y - a.rect.y) * a.rect.width + x - a.rect.x) * 4 + 3]! > 0 && b.layer[((y - b.rect.y) * b.rect.width + x - b.rect.x) * 4 + 3]! > 0) return true;
    }
  }
  return false;
}

/** Где ищет палочка: в слое owner или на фоне — всё, кроме видимых слоёв */
function scopeOf(doc: CanvasDocument, owner: DocObject | null): Scope {
  return owner ? { layer: owner } : { outside: doc.visibleLayers() };
}

/** Версия слоя, которую видно: текущая, а без неё у отделённого — снятый исходник */
function visibleVersion(doc: CanvasDocument, objectId: string): string | undefined {
  const o = doc.objects.find((x) => x.id === objectId);
  return o && (o.current ?? liftedLayer(doc, objectId)?.id);
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

/**
 * Перерисовка всего слоя (весь он в выделении): маска задачи шире слоя на растушёвку. Растушёвка идёт внутрь маски,
 * и по маске точно по слою весь его край выходил полупрозрачным, а тонкое (ствол дерева) — насквозь. Кольцо —
 * не выделение: слой растёт только по выделенному (claim), «Ещё варианты» его не растят, иначе с каждой перерисовкой
 * слой раздувался бы на кольцо
 */
function ringed(doc: CanvasDocument, job: Job, selected: RawImage & { x: number; y: number }, feather: number): RawImage & { x: number; y: number } {
  const owner = job.object && !job.fillFor ? doc.objects.find((o) => o.id === job.object) : undefined;
  if (!owner || owner.kind === 'fill') return selected;
  const sel: Bitmap = { rect: { x: selected.x, y: selected.y, width: selected.width, height: selected.height }, mask: selected.data };
  job.whole ??= overlap(owner, sel) === area(owner);
  if (!job.whole) return selected;
  job.claim = job.from ? null : trim(sel);
  const { rect, mask } = unionBitmap(sel, dilate(owner, feather, { x: 0, y: 0, width: doc.width, height: doc.height }));
  return { data: Buffer.from(mask.buffer, mask.byteOffset, mask.length), width: rect.width, height: rect.height, channels: 1, x: rect.x, y: rect.y };
}

/** Маска слоя одним каналом на его месте на холсте — так её принимает prepareEdit */
function layerMask({ mask, rect }: Replaced): RawImage & { x: number; y: number } {
  return { data: Buffer.from(mask.buffer, mask.byteOffset, mask.length), width: rect.width, height: rect.height, channels: 1, x: rect.x, y: rect.y };
}
