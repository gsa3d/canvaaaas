// Состояние приложения: открытый документ, очередь задач на генерацию и их варианты.
// Ответ модели каждого варианта хранится в размере куска, поэтому смена маски — только перевклейка,
// без новой генерации.
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { CanvasDocument, TILE_SIZE } from '../core/document.ts';
import { buildLayer, fitGenerated, insideOf, measure, prepareEdit, type PreparedEdit, type RawImage } from '../core/edit-region.ts';
import { intersect } from '../core/frame.ts';
import { expandMaskByDiff } from '../core/expand.ts';
import { readLedger, withLedger } from '../core/ledger.ts';
import { featherAlpha } from '../core/mask.ts';
import { applyShapes } from '../core/mask-shapes.ts';
import type { KeyStore } from '../core/secrets.ts';
import { laozhangGemini } from '../providers/laozhang-gemini.ts';
import { mockProvider } from '../providers/mock.ts';
import type { ImageProvider, InputImage } from '../providers/types.ts';
import { MAX_REFERENCES, shapesBBox, type CreateJobRequest, type JobDto, type MaskShape, type ModelChoice, type RectDto, type SizeChoice, type StateDto } from '../shared/api.ts';

const MAX_RUNNING_JOBS = 2;
const MAX_VARIANTS_PER_JOB = 8;
const MASK_UNDO_LIMIT = 30;
const REFERENCES_KEPT = 30;
/** Референс уменьшается до этого размера по большей стороне: модели больше не нужно */
const REFERENCE_SIZE = 1536;

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
}

interface Job {
  id: string;
  docId: string;
  prompt: string;
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
  prep?: PreparedEdit;
  /** Текущая маска части куска внутри холста — её можно править после генерации */
  mask?: Uint8Array;
  alpha?: Float32Array;
  maskUndo: Uint8Array[];
  variants: Variant[];
  selected: number;
  rev: number;
  layerPngs: Map<number, Buffer>;
  maskPng?: Buffer;
  abort: AbortController;
  /** Правки маски идут строго по очереди */
  maskChain: Promise<unknown>;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class Session {
  readonly providerKind: 'laozhang' | 'mock';
  private readonly keys: KeyStore;
  private hasKey = false;
  doc: CanvasDocument | null = null;
  private jobs: Job[] = [];
  private readonly providers = new Map<ModelChoice, ImageProvider>();
  private generations = 0;
  private todayAtStart = 0;
  private readonly listeners = new Set<() => void>();
  private readonly references = new Map<string, Reference>();
  private emitTimer: NodeJS.Timeout | undefined;

  constructor(providerKind: 'laozhang' | 'mock', keys: KeyStore) {
    this.providerKind = providerKind;
    this.keys = keys;
  }

  async init(): Promise<void> {
    this.hasKey = (await this.keys.get()) !== null;
    if (this.providerKind !== 'laozhang') return;
    const today = new Date().toISOString().slice(0, 10);
    this.todayAtStart = (await readLedger()).filter((e) => e.at.startsWith(today)).length;
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
          : withLedger(laozhangGemini({ model, apiKey: () => this.apiKey() }), 'ui');
      this.providers.set(model, p);
    }
    return p;
  }

  private async apiKey(): Promise<string> {
    const key = await this.keys.get();
    if (!key) throw new Error('Нет ключа laozhang.ai: добавьте его кнопкой «Ключ» вверху окна');
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

  state(): StateDto {
    const doc = this.doc;
    return {
      provider: this.providerKind,
      hasKey: this.hasKey || this.providerKind === 'mock',
      doc: doc && {
        id: doc.id,
        name: doc.name,
        width: doc.width,
        height: doc.height,
        rev: doc.rev,
        levels: doc.levelCount,
        tileSize: TILE_SIZE,
        style: doc.style,
      },
      jobs: this.jobs.map((j) => ({
        id: j.id,
        prompt: j.prompt,
        model: j.model,
        status: j.status,
        error: j.error,
        createdAt: j.createdAt,
        refs: j.references.length,
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
        })),
        selected: j.selected,
        rev: j.rev,
        canUndoMask: j.maskUndo.length > 0,
      })),
      history: (doc?.patches ?? []).map((p) => ({
        id: p.id,
        prompt: p.prompt,
        rect: p.rect,
        active: p.active,
        createdAt: p.createdAt,
      })),
      canUndo: doc?.canUndo ?? false,
      canRedo: doc?.canRedo ?? false,
      generations: { session: this.generations, today: this.todayAtStart + this.generations },
    };
  }

  // ——— Документ ———

  async openDocument(input: Buffer | string, name: string): Promise<void> {
    const doc = await CanvasDocument.open(input, name);
    this.dropAllJobs();
    this.doc = doc;
    this.changed();
  }

  newDocument(width: number, height: number, color: [number, number, number]): void {
    const doc = CanvasDocument.blank(width, height, color, `Холст ${width}×${height}`);
    this.dropAllJobs();
    this.doc = doc;
    this.changed();
  }

  setStyle(style: string): void {
    this.requireDoc().style = style;
    this.changed();
  }

  undo(): void {
    this.requireDoc().undo();
    this.changed();
  }

  redo(): void {
    this.requireDoc().redo();
    this.changed();
  }

  togglePatch(patchId: string): void {
    this.requireDoc().togglePatch(patchId);
    this.changed();
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
    const doc = this.requireDoc();
    if (!req.prompt.trim()) throw new Error('Пустой промпт');
    const area = shapesBBox(req.shapes);
    if (!area) throw new Error('Нет выделения');
    const variants = Math.min(Math.max(Math.round(req.variants), 1), 4);
    const refIds = req.refs ?? [];
    if (refIds.length > MAX_REFERENCES) throw new Error(`Не больше ${MAX_REFERENCES} референсов на правку`);
    const references = refIds.map((id) => {
      const ref = this.references.get(id);
      if (!ref) throw new Error('Референс не найден — добавьте картинку заново');
      return ref.image;
    });
    const job: Job = {
      id: randomUUID(),
      docId: doc.id,
      prompt: req.prompt.trim(),
      style: doc.style,
      model: req.model,
      size: req.size,
      createdAt: new Date().toISOString(),
      status: 'queued',
      shapes: req.shapes,
      area,
      variantsRequested: variants,
      references,
      maskUndo: [],
      variants: [],
      selected: 0,
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
      const prep = await prepareEdit({
        image: doc.raw(),
        mask: await this.rasterize(job, doc),
        prompt: job.prompt,
        style: job.style,
        provider: this.provider(job.model),
        imageSize: job.size,
        references: job.references,
      });
      job.prep = prep;
      job.mask = prep.insideMask;
      job.alpha = prep.alpha;
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

  private async generate(job: Job, count: number): Promise<void> {
    const prep = job.prep;
    if (!prep) throw new Error('Задача ещё не подготовлена');
    const provider = this.provider(job.model);
    const fresh = Array.from({ length: count }, (_, i): Variant => ({ n: job.variants.length + i, status: 'running' }));
    job.variants.push(...fresh);
    job.status = 'running';
    job.error = undefined;
    this.changed();

    await Promise.all(
      fresh.map(async (v) => {
        try {
          this.generations++;
          const res = await provider.generate({
            prompt: prep.prompt,
            images: prep.images,
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
          if (job.variants[job.selected]?.status !== 'done') job.selected = v.n;
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

  selectVariant(jobId: string, n: number): void {
    const job = this.job(jobId);
    if (job.variants[n]?.status !== 'done') throw new Error('Вариант не готов');
    job.selected = n;
    this.changed();
  }

  /** «Ещё варианты»: та же правка, новые генерации к уже имеющимся */
  async moreVariants(jobId: string, count: number): Promise<void> {
    const job = this.job(jobId);
    if (job.status === 'running' || job.status === 'preparing' || job.status === 'queued') throw new Error('Задача ещё идёт');
    if (!job.prep) return this.retry(jobId);
    const n = Math.min(Math.max(Math.round(count), 1), MAX_VARIANTS_PER_JOB - job.variants.length);
    if (n <= 0) throw new Error(`Не больше ${MAX_VARIANTS_PER_JOB} вариантов на правку`);
    try {
      await this.generate(job, n);
    } finally {
      this.changed();
    }
  }

  /** Задача с ошибкой: начать заново с подготовки куска */
  retry(jobId: string): void {
    const job = this.job(jobId);
    if (job.status !== 'error') throw new Error('Повторить можно только задачу с ошибкой');
    job.abort = new AbortController();
    Object.assign(job, { status: 'queued', error: undefined, prep: undefined, mask: undefined, alpha: undefined, variants: [], maskUndo: [], selected: 0 });
    job.layerPngs.clear();
    job.maskPng = undefined;
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

  accept(jobId: string): void {
    const job = this.readyJob(jobId);
    const doc = this.requireDoc();
    if (doc.id !== job.docId) throw new Error('Задача от другого документа');
    const v = job.variants[job.selected];
    if (v?.status !== 'done' || !v.gen) throw new Error('Выбранный вариант не готов');
    doc.addPatch({
      id: randomUUID(),
      rect: job.prep.frame.inside,
      layer: buildLayer(job.prep, v.gen, job.alpha),
      prompt: job.prompt,
      jobId: job.id,
      variant: v.n,
      createdAt: new Date().toISOString(),
    });
    this.discard(jobId);
  }

  // ——— Маска задачи после генерации ———

  private serial<T>(job: Job, fn: () => Promise<T> | T): Promise<T> {
    const next = job.maskChain.then(fn);
    job.maskChain = next.catch(() => undefined);
    return next;
  }

  private remask(job: Job & { prep: PreparedEdit; mask: Uint8Array }, mask: Uint8Array): void {
    job.maskUndo.push(job.mask);
    if (job.maskUndo.length > MASK_UNDO_LIMIT) job.maskUndo.shift();
    this.setMask(job, mask);
  }

  private setMask(job: Job & { prep: PreparedEdit }, mask: Uint8Array): void {
    const { inside } = job.prep.frame;
    job.mask = mask;
    job.alpha = featherAlpha(mask, inside.width, inside.height, job.prep.feather);
    job.rev++;
    job.layerPngs.clear();
    job.maskPng = undefined;
    this.changed();
  }

  /** Дорисовать или стереть маску задачи и перевклеить все варианты */
  editMask(jobId: string, shapes: MaskShape[]): Promise<void> {
    const job = this.readyJob(jobId);
    return this.serial(job, async () => {
      this.remask(job, await applyShapes(job.mask, job.prep.frame.inside, shapes));
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

  /** Слой варианта: цвет ответа модели и растушёванная маска в альфе, PNG размером с часть куска на холсте */
  async layerPng(jobId: string, n: number): Promise<Buffer> {
    const job = this.readyJob(jobId);
    const cached = job.layerPngs.get(n);
    if (cached) return cached;
    const v = job.variants[n];
    if (v?.status !== 'done' || !v.gen) throw new Error('Вариант не готов');
    const { inside } = job.prep.frame;
    const png = await sharp(buildLayer(job.prep, v.gen, job.alpha), {
      raw: { width: inside.width, height: inside.height, channels: 4 },
    })
      .png({ compressionLevel: 2 })
      .toBuffer();
    job.layerPngs.set(n, png);
    return png;
  }

  /** Маска задачи для показа поверх холста: полупрозрачная голубая заливка */
  async maskPng(jobId: string): Promise<Buffer> {
    const job = this.readyJob(jobId);
    if (job.maskPng) return job.maskPng;
    const { inside } = job.prep.frame;
    const rgba = Buffer.alloc(inside.width * inside.height * 4);
    for (let i = 0; i < job.mask.length; i++) {
      const m = job.mask[i]!;
      if (m === 0) continue;
      rgba.set([40, 140, 255, Math.round(m * 0.45)], i * 4);
    }
    job.maskPng = await sharp(rgba, { raw: { width: inside.width, height: inside.height, channels: 4 } })
      .png({ compressionLevel: 2 })
      .toBuffer();
    return job.maskPng;
  }
}
