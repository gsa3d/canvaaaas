// Состояние приложения: открытый документ, очередь задач на генерацию и их варианты.
// Ответ модели каждого варианта хранится в размере куска, поэтому смена маски — только перевклейка,
// без новой генерации.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import sharp from 'sharp';
import { CanvasDocument, TILE_SIZE, type NewPatch } from '../core/document.ts';
import { encodeImage, formatOf, inspectImage, writeFileAtomic, type ImageFile, type ImageFormat } from '../core/image-file.ts';
import { encodeProject, isProject, isProjectPath, openProject, PROJECT_EXTENSION } from '../core/project.ts';
import type { RecentFiles } from '../core/recent.ts';
import {
  buildLayer,
  directorImages,
  fitGenerated,
  insideOf,
  layerAsGen,
  measure,
  overviewImage,
  prepareEdit,
  retarget,
  type Guide,
  type PreparedEdit,
  type RawImage,
} from '../core/edit-region.ts';
import { intersect, type Rect } from '../core/frame.ts';
import { expandMaskByDiff } from '../core/expand.ts';
import { readLedger, withDirectorLedger, withLedger } from '../core/ledger.ts';
import { featherAlpha, featherAlphaRegion, maskBBox } from '../core/mask.ts';
import { applyShapes, applyShapesRegion } from '../core/mask-shapes.ts';
import type { KeyStore } from '../core/secrets.ts';
import { checkSketch } from '../core/sketch.ts';
import { chatgptCodex, chatgptDirector, findCodex } from '../providers/chatgpt-codex.ts';
import { mockDirector, type PromptDirector } from '../providers/director.ts';
import { laozhangGemini } from '../providers/laozhang-gemini.ts';
import { mockProvider } from '../providers/mock.ts';
import type { ImageProvider, InputImage } from '../providers/types.ts';
import {
  MAX_REFERENCES,
  shapesBBox,
  type CreateJobRequest,
  type JobDto,
  type MaskEditResult,
  type MaskShape,
  type ModelChoice,
  type PatchVariantsRequest,
  type RectDto,
  type RedoChange,
  type SizeChoice,
  type SketchStroke,
  type StateDto,
} from '../shared/api.ts';

const MAX_RUNNING_JOBS = 2;
const MAX_VARIANTS_PER_JOB = 8;
const MASK_UNDO_LIMIT = 30;
const REFERENCES_KEPT = 30;
/** Референс уменьшается до этого размера по большей стороне: модели больше не нужно */
const REFERENCE_SIZE = 1536;
/** Картинки для правки маски в браузере — не больше этого по большей стороне */
const EDIT_PREVIEW_MAX = 2560;

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
  /** Слой, который сейчас на холсте: с ним сравнивают новые варианты */
  current?: boolean;
  /** С какой задачей и показом области сделан: ими же ляжет слой */
  prompt: string;
  hide: boolean;
  /** Задача, как её расписал директор */
  directed?: string;
}

/** Принятый слой, который правка перерисовывает: маска и место — на момент, когда попросили ещё вариантов */
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
  /** Ещё варианты принятого слоя: «Принять» кладёт вариант на его место */
  replaces?: Replaced;
  prep?: PreparedEdit;
  /** Текущая маска части куска внутри холста — её можно править после генерации */
  mask?: Uint8Array;
  alpha?: Float32Array;
  maskUndo: Uint8Array[];
  /** Растёт при каждой смене маски */
  maskRev: number;
  variants: Variant[];
  selected: number;
  /** Вариант выбрали руками: новые готовые его не перебивают */
  picked: boolean;
  rev: number;
  layerPngs: Map<number, Buffer>;
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
  }

  async init(): Promise<void> {
    this.hasKey = (await this.keys.get()) !== null;
    this.codex = findCodex();
    if (this.providerKind !== 'laozhang') return;
    const today = new Date().toISOString().slice(0, 10);
    this.todayAtStart = (await readLedger()).filter((e) => e.at.startsWith(today) && e.kind !== 'director').length;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    // Превью замены слоя показывает участок холста целиком, поэтому устаревает при любой правке документа
    if (this.doc?.rev !== this.previewRev) {
      this.previewRev = this.doc?.rev;
      for (const job of this.jobs) {
        if (!job.replaces) continue;
        job.rev++;
        job.layerPngs.clear();
      }
    }
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
          prompt: v.prompt,
          hide: v.hide,
          directed: v.directed,
        })),
        selected: j.selected,
        rev: j.rev,
        maskRev: j.maskRev,
        feather: j.prep?.feather,
        canUndoMask: j.maskUndo.length > 0,
        replaces: j.replaces?.patchId,
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
      })),
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

  /** Есть несохранённые изменения холста; у проекта .caaa — и скрытых слоёв, и стиля */
  get dirty(): boolean {
    if (!this.doc) return false;
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
    if (doc.patches.length && !this.flattened && this.host) {
      const answer = await this.host.ask({
        message: 'Сохранить слои?',
        detail: 'Слои останутся слоями, только если сохранить документ в формате canvaaaas (.caaa): после повторного открытия их можно будет скрывать и править их маски. В картинке они сольются с холстом.',
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

  /** Слои документа пойдут в .caaa, а не сольются в картинку */
  private keepsLayers(): boolean {
    return this.file?.format === PROJECT_EXTENSION || (this.requireDoc().patches.length > 0 && !this.flattened);
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

  /** Удалить слой: обычный шаг истории, ⌘Z его возвращает */
  removePatch(patchId: string): Promise<void> {
    return this.serialDoc((doc) => {
      doc.removePatch(patchId);
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
      if (changed) doc.setPatchMask(patchId, mask, changed);
      this.changed();
      return { version: patch.maskVersion, rev: doc.rev };
    });
  }

  /**
   * Картинки, по которым браузер сам показывает правку маски слоя или задачи, не дожидаясь сервера: холст под слоем,
   * слои над ним, ответ модели на весь кусок и маска до растушёвки — в размере превью. version — чья маска в картинке.
   */
  async maskEditImage(target: { patch: string } | { job: string; n: number }, part: string): Promise<{ data: Buffer; type: string; version: number }> {
    const doc = this.requireDoc();
    let rect: Rect;
    let skip: string | null;
    let mask: Uint8Array;
    let version: number;
    let rgb: () => Buffer;
    if ('patch' in target) {
      const patch = doc.patch(target.patch);
      ({ rect, mask, maskVersion: version } = patch);
      skip = patch.id;
      rgb = () => {
        const out = Buffer.alloc(rect.width * rect.height * 3);
        for (let i = 0; i < rect.width * rect.height; i++) patch.layer.copy(out, i * 3, i * 4, i * 4 + 3);
        return out;
      };
    } else {
      const job = this.readyJob(target.job);
      rect = job.prep.frame.inside;
      skip = job.replaces && doc.hasPatch(job.replaces.patchId) ? job.replaces.patchId : null;
      mask = job.mask;
      version = job.maskRev;
      rgb = () => {
        const gen = job.variants[target.n]?.gen;
        if (!gen) throw new Error('Вариант не готов');
        return insideOf(job.prep, gen);
      };
    }
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
    const area = shapesBBox(req.shapes);
    if (!area) throw new Error('Нет выделения');
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
      shapes: req.shapes,
      area,
      references,
      sketch: checkSketch(req.sketch),
      director: !!req.director,
    });
  }

  /**
   * «Ещё варианты» принятого слоя: та же задача (или поправленная), маска слоя, его референсы и набросок; модель видит холст
   * под слоем, а не его самого. Нынешний слой становится первым вариантом, чтобы новые было с чем сравнить;
   * «Принять» кладёт выбранный на его место. С той же задачей директор не нужен заново: слой помнит его текст.
   */
  patchVariants(patchId: string, req: PatchVariantsRequest): string {
    const patch = this.requireDoc().patch(patchId);
    const box = maskBBox(patch.mask, patch.rect.width, patch.rect.height);
    if (!box) throw new Error('Маска слоя пустая: верните кистью то, что нужно перерисовать');
    return this.enqueue({
      prompt: req.prompt?.trim() || patch.prompt,
      hide: req.hide ?? patch.hide ?? false,
      model: patch.model ?? req.model,
      size: patch.size ?? req.size,
      variants: req.variants,
      shapes: [],
      area: { ...box, x: box.x + patch.rect.x, y: box.y + patch.rect.y },
      references: patch.refs ?? [],
      sketch: patch.sketch ?? [],
      director: req.director ?? patch.directed !== undefined,
      directed: patch.directed ? { key: taskKey({ prompt: patch.prompt, hide: patch.hide ?? false }), text: patch.directed } : undefined,
      replaces: { patchId, mask: patch.mask, rect: patch.rect, feather: patch.feather },
    });
  }

  private enqueue(
    task: Pick<Job, 'prompt' | 'hide' | 'model' | 'size' | 'shapes' | 'area' | 'references' | 'sketch' | 'director' | 'directed' | 'replaces'> & {
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
      maskUndo: [],
      maskRev: 0,
      variants: [],
      selected: 0,
      picked: false,
      rev: 1,
      layerPngs: new Map(),
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
      // Слой могли удалить, пока задача ждала очереди: тогда вариант ляжет новым слоем
      const { replaces } = job;
      const current = replaces && doc.hasPatch(replaces.patchId) ? doc.patch(replaces.patchId) : null;
      const prep = await prepareEdit({
        image: doc.raw(),
        mask: replaces ? layerMask(replaces) : await this.rasterize(job, doc),
        crop: current ? (inside) => doc.regionWithout(inside, current.id) : undefined,
        feather: replaces?.feather,
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
    const region = await applyShapes(new Uint8Array(area.width * area.height), area, job.shapes);
    return { data: Buffer.from(region.buffer, region.byteOffset, region.length), width: area.width, height: area.height, channels: 1, x: area.x, y: area.y };
  }

  /**
   * Новые варианты с нынешней задачей и показом области задачи. Готовые остаются на холсте, пока идут новые:
   * их можно сравнивать и принимать. jump — задачу поправили: первый готовый новый вариант сразу на холсте.
   */
  private async generate(job: Job, count: number, jump = false): Promise<void> {
    const prep = job.prep;
    if (!prep) throw new Error('Задача ещё не подготовлена');
    const provider = this.provider(job.model);
    const task = { prompt: job.prompt, hide: job.hide };
    const director = job.director;
    const fresh = Array.from({ length: count }, (_, i): Variant => ({ n: job.variants.length + i, status: 'running', ...task }));
    job.variants.push(...fresh);
    if (!job.variants.some((v) => v.status === 'done')) job.status = 'running';
    job.error = undefined;
    this.changed();

    // Директор — один раз на все новые варианты; промпт и картинки для модели собираются заново,
    // только если задачу, показ области или текст директора поправили
    const ready = (async () => {
      const guide = guideOf(task.hide);
      const directed = director ? await this.direct(job, prep, task) : undefined;
      if (prep.request !== task.prompt || prep.guide !== guide || prep.directed !== directed) {
        Object.assign(prep, await retarget(prep, { request: task.prompt, guide, directed }));
      }
      return { prompt: prep.prompt, images: prep.images, directed };
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
          v.directed = input.directed;
          v.elapsedMs = res.elapsedMs;
          v.outsideChangedPct = stats.outsideChangedPct;
          v.insideChangedPct = stats.insideChangedPct;
          v.status = 'done';
          // Первый готовый новый вариант сразу на холсте, даже если до него был выбран нынешний слой
          // (или вариант по прежней задаче), — если только пользователь сам не выбрал другой
          const selected = job.variants[job.selected];
          if (selected?.status !== 'done' || (!job.picked && (selected.current || (jump && !shown)))) job.selected = v.n;
          shown = true;
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

  /** Задача, как её расписал директор; для той же задачи и показа области — прежний текст без нового вызова */
  private async direct(job: Job, prep: PreparedEdit, task: { prompt: string; hide: boolean }): Promise<string> {
    const key = taskKey(task);
    if (job.directed?.key === key) return job.directed.text;
    const doc = this.doc;
    job.directing = true;
    this.changed();
    try {
      const overview = doc?.id === job.docId ? await overviewImage(await doc.thumbnail(1024), prep.canvas, prep.frame.rect) : undefined;
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

  selectVariant(jobId: string, n: number): void {
    const job = this.job(jobId);
    if (job.variants[n]?.status !== 'done') throw new Error('Вариант не готов');
    job.selected = n;
    job.picked = true;
    this.changed();
  }

  /** «Ещё варианты»: та же правка или с поправкой задачи, новые генерации к уже имеющимся */
  async moreVariants(jobId: string, count: number, change: RedoChange = {}): Promise<void> {
    const job = this.job(jobId);
    const busy = job.status === 'running' || job.status === 'preparing' || job.status === 'queued' || job.variants.some((v) => v.status === 'running');
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
    Object.assign(job, { status: 'queued', error: undefined, prep: undefined, mask: undefined, alpha: undefined, variants: [], maskUndo: [], selected: 0, picked: false });
    job.maskRev++;
    job.layerPngs.clear();
    this.changed();
    this.schedule();
  }

  /** Убрать задачу: отклонить варианты или отменить генерацию */
  discard(jobId: string): void {
    const job = this.job(jobId);
    job.abort.abort();
    this.jobs = this.jobs.filter((j) => j !== job);
    this.changed();
    this.schedule();
  }

  /** Принять выбранный вариант: новым слоем сверху или, если это ещё варианты слоя, на его место */
  accept(jobId: string): void {
    const job = this.readyJob(jobId);
    const doc = this.requireDoc();
    if (doc.id !== job.docId) throw new Error('Задача от другого документа');
    const v = job.variants[job.selected];
    if (v?.status !== 'done' || !v.gen) throw new Error('Выбранный вариант не готов');
    const target = job.replaces && doc.hasPatch(job.replaces.patchId) ? job.replaces.patchId : null;
    // Оставили нынешний слой и маску не трогали — менять нечего
    if (!(v.current && target && job.mask === job.prep.insideMask)) {
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
      if (target) doc.replacePatch(target, patch);
      else doc.addPatch(patch);
    }
    this.discard(jobId);
  }

  // ——— Маска задачи после генерации ———

  private serial<T>(job: Job, fn: () => Promise<T> | T): Promise<T> {
    const next = job.maskChain.then(fn);
    job.maskChain = next.catch(() => undefined);
    return next;
  }

  private remask(job: Job & { prep: PreparedEdit; mask: Uint8Array; alpha: Float32Array }, mask: Uint8Array, changed?: Rect): void {
    job.maskUndo.push(job.mask);
    if (job.maskUndo.length > MASK_UNDO_LIMIT) job.maskUndo.shift();
    this.setMask(job, mask, changed);
  }

  /** Новая маска задачи; changed — участок, вне которого она не менялась: растушёвка пересчитывается только около него */
  private setMask(job: Job & { prep: PreparedEdit; alpha: Float32Array }, mask: Uint8Array, changed?: Rect): void {
    const { inside } = job.prep.frame;
    if (changed) {
      const { rect, alpha } = featherAlphaRegion(mask, inside.width, inside.height, job.prep.feather, changed);
      // Копия: прежняя альфа может быть альфой подготовки куска
      const next = new Float32Array(job.alpha);
      for (let row = 0; row < rect.height; row++) next.set(alpha.subarray(row * rect.width, (row + 1) * rect.width), (rect.y + row) * inside.width + rect.x);
      job.alpha = next;
    } else {
      job.alpha = featherAlpha(mask, inside.width, inside.height, job.prep.feather);
    }
    job.mask = mask;
    job.maskRev++;
    job.rev++;
    job.layerPngs.clear();
    this.changed();
  }

  /** Дорисовать или стереть маску задачи и перевклеить все варианты */
  editMask(jobId: string, shapes: MaskShape[]): Promise<MaskEditResult> {
    const job = this.readyJob(jobId);
    return this.serial(job, async () => {
      const { mask, changed } = await applyShapesRegion(job.mask, job.prep.frame.inside, shapes);
      if (changed) this.remask(job, mask, changed);
      return { version: job.maskRev, rev: job.rev };
    });
  }

  /** Добавить к маске то, что модель нарисовала за её краем в выбранном варианте */
  expandMask(jobId: string): Promise<number> {
    const job = this.readyJob(jobId);
    return this.serial(job, () => {
      const v = job.variants[job.selected];
      if (v?.status !== 'done' || !v.gen) throw new Error('Выбранный вариант не готов');
      const { inside } = job.prep.frame;
      const { mask, addedPx } = expandMaskByDiff(
        job.mask,
        insideOf(job.prep, job.prep.frameRgb),
        insideOf(job.prep, v.gen),
        inside.width,
        inside.height,
      );
      if (addedPx > 0) this.remask(job, mask);
      return addedPx;
    });
  }

  undoMask(jobId: string): Promise<void> {
    const job = this.readyJob(jobId);
    return this.serial(job, () => {
      const prev = job.maskUndo.pop();
      if (prev) this.setMask(job, prev);
    });
  }

  /**
   * Слой варианта: цвет ответа модели и растушёванная маска в альфе, PNG размером с часть куска на холсте.
   * Вариант на замену слоя ложится не поверх него, а вместо: показываем участок холста, каким он станет, — везде,
   * где лежит новый или прежний слой, иначе у края растушёвки и там, где маску сузили, проглядывал бы прежний.
   */
  async layerPng(jobId: string, n: number): Promise<Buffer> {
    const job = this.readyJob(jobId);
    const cached = job.layerPngs.get(n);
    if (cached) return cached;
    const v = job.variants[n];
    if (v?.status !== 'done' || !v.gen) throw new Error('Вариант не готов');
    const { inside } = job.prep.frame;
    const rev = job.rev;
    const layer = buildLayer(job.prep, v.gen, job.alpha);
    const doc = this.requireDoc();
    const target = job.replaces && doc.hasPatch(job.replaces.patchId) ? doc.patch(job.replaces.patchId) : null;
    if (target) {
      const after = doc.regionReplaced(inside, target.id, inside, layer);
      const old = target.rect;
      for (let y = 0; y < inside.height; y++) {
        for (let x = 0; x < inside.width; x++) {
          const i = y * inside.width + x;
          const ox = inside.x + x - old.x;
          const oy = inside.y + y - old.y;
          const under = ox >= 0 && oy >= 0 && ox < old.width && oy < old.height && target.layer[(oy * old.width + ox) * 4 + 3]! > 0;
          layer[i * 4] = after[i * 3]!;
          layer[i * 4 + 1] = after[i * 3 + 1]!;
          layer[i * 4 + 2] = after[i * 3 + 2]!;
          layer[i * 4 + 3] = under || layer[i * 4 + 3]! > 0 ? 255 : 0;
        }
      }
    }
    const png = await sharp(layer, {
      raw: { width: inside.width, height: inside.height, channels: 4 },
    })
      .png({ compressionLevel: 2 })
      .toBuffer();
    // Пока кодировали, маска или холст могли измениться: такую картинку не кэшируем
    if (job.rev === rev) job.layerPngs.set(n, png);
    return png;
  }

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
