// Просмотр холста: OpenSeadragon тянет тайлы с сервера, поверх — канвас размером с экран
// для выделения, контуров задач и курсора кисти. Фигуры хранятся в координатах холста,
// поэтому большой canvas в браузере не нужен ни для какой операции.
import OpenSeadragon from 'openseadragon';
import type { DocDto, JobDto, MaskShape, RectDto } from '../shared/api.ts';

export type Tool = 'hand' | 'rect' | 'lasso' | 'brush' | 'eraser';

const ACCENT = '#2F5BEA';
const ERROR = '#C8431A';

/** Маска принятого слоя, которую сейчас правят */
export interface LayerMaskView {
  id: string;
  /** Меняется вместе с маской: по нему перезапрашивается картинка */
  key: string;
  url: string;
  rect: RectDto;
}

export interface ViewerHooks {
  onShape(shape: MaskShape): void;
  onZoom(percent: number): void;
}

interface Draft {
  kind: 'rect' | 'lasso' | 'stroke';
  points: [number, number][];
  erase: boolean;
  size: number;
}

interface Layer {
  key: string;
  item?: OpenSeadragon.TiledImage;
}

type ItemEvent = { item: OpenSeadragon.TiledImage };

function round(v: number): number {
  return Math.round(v * 10) / 10;
}

function shapePath(shape: MaskShape | Draft): Path2D {
  const path = new Path2D();
  if (shape.kind === 'rect' && 'width' in shape) {
    path.rect(shape.x, shape.y, shape.width, shape.height);
  } else if (shape.kind === 'ellipse') {
    path.ellipse(shape.cx, shape.cy, shape.rx, shape.ry, 0, 0, Math.PI * 2);
  } else if ('points' in shape) {
    const pts = shape.points;
    if (shape.kind === 'rect') {
      const [a, b] = [pts[0]!, pts[pts.length - 1]!];
      path.rect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
    } else {
      pts.forEach(([x, y], i) => (i ? path.lineTo(x, y) : path.moveTo(x, y)));
      if (shape.kind === 'polygon' || shape.kind === 'lasso') path.closePath();
    }
  }
  return path;
}

export class CanvasView {
  private readonly viewer: OpenSeadragon.Viewer;
  private readonly container: HTMLElement;
  private readonly overlay: HTMLCanvasElement;
  private readonly fill = document.createElement('canvas');
  private readonly edge = document.createElement('canvas');
  private readonly hooks: ViewerHooks;

  private doc: DocDto | null = null;
  private base: OpenSeadragon.TiledImage | null = null;
  private readonly baseItems = new Map<OpenSeadragon.TiledImage, number>();
  /** Сколько версий холста лежит в мире или добавляется — все они внизу, под слоями задач */
  private baseCount = 0;
  /** Версия холста, которая догружается; пока она есть, слои принятых правок не убираем */
  private pendingRev: number | null = null;
  private readonly layers = new Map<string, Layer>();
  private deferredRemovals: OpenSeadragon.TiledImage[] = [];

  private tool: Tool = 'rect';
  private spaceHeld = false;
  private brushPx = 40;
  private selection: MaskShape[] = [];
  private jobs: JobDto[] = [];
  private numbers = new Map<string, number>();
  private focused: string | null = null;
  private maskJob: string | null = null;
  private layerMask: LayerMaskView | null = null;
  /** Фигуры, ушедшие в маску: видны, пока не пришла обновлённая маска */
  private pending: MaskShape[] = [];
  private draft: Draft | null = null;
  private cursor: { x: number; y: number } | null = null;
  private frame = 0;

  constructor(container: HTMLElement, hooks: ViewerHooks) {
    this.container = container;
    this.hooks = hooks;
    this.viewer = OpenSeadragon({
      element: container,
      drawer: 'canvas',
      showNavigationControl: false,
      maxZoomPixelRatio: 6,
      minZoomImageRatio: 0.5,
      visibilityRatio: 0.3,
      animationTime: 0.35,
      zoomPerScroll: 1.25,
      preserveImageSizeOnResize: true,
      gestureSettingsMouse: { clickToZoom: false, dblClickToZoom: true, flickEnabled: false },
    });

    this.overlay = document.createElement('canvas');
    this.overlay.className = 'stage-overlay';
    container.appendChild(this.overlay);
    new ResizeObserver(() => this.resize()).observe(container);

    this.viewer.addHandler('canvas-press', (e) => this.press(e.position, e.originalEvent as MouseEvent));
    this.viewer.addHandler('canvas-drag', (e) => {
      if (!this.draft) return;
      e.preventDefaultAction = true;
      this.move(e.position);
    });
    this.viewer.addHandler('canvas-release', () => this.release());
    this.viewer.addHandler('animation', () => this.redraw());
    this.viewer.addHandler('update-viewport', () => this.redraw());
    this.viewer.addHandler('animation', () => this.reportZoom());
    this.viewer.addHandler('animation-finish', () => this.reportZoom());
    this.viewer.addHandler('open', () => {
      this.base = this.viewer.world.getItemAt(0);
      if (this.base && this.doc) this.baseItems.set(this.base, this.doc.rev);
      this.reportZoom();
      this.redraw();
    });

    // Прокрутка двумя пальцами (и колесо мыши) двигает картинку, как в графических редакторах.
    // Щипок приходит колесом с ctrlKey, ⌘ + колесо — с metaKey: их пропускаем к OpenSeadragon, он масштабирует
    container.addEventListener(
      'wheel',
      (e) => {
        if (e.ctrlKey || e.metaKey) return;
        e.preventDefault();
        e.stopPropagation();
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? container.clientHeight : 1;
        // Shift + колесо мыши — по горизонтали (на macOS система делает это сама)
        const [dx, dy] = e.shiftKey && !e.deltaX ? [e.deltaY, 0] : [e.deltaX, e.deltaY];
        const viewport = this.viewer.viewport;
        viewport.panBy(viewport.deltaPointsFromPixels(new OpenSeadragon.Point(dx * unit, dy * unit)), true);
        viewport.applyConstraints(true);
      },
      { capture: true, passive: false },
    );

    container.addEventListener('pointermove', (e) => {
      const r = container.getBoundingClientRect();
      this.cursor = { x: e.clientX - r.left, y: e.clientY - r.top };
      if (this.tool === 'brush' || this.tool === 'eraser') this.redraw();
    });
    container.addEventListener('pointerleave', () => {
      this.cursor = null;
      this.redraw();
    });
    this.applyCursor();
  }

  // ——— Что показывать ———

  setDocument(doc: DocDto | null): void {
    const prev = this.doc;
    this.doc = doc;
    if (!doc) {
      this.viewer.close();
      this.reset();
      return;
    }
    if (prev?.id !== doc.id) {
      this.reset();
      this.baseCount = 1;
      this.viewer.open({ tileSource: this.tileSource(doc) } as OpenSeadragon.TileSourceSpecifier);
      return;
    }
    if (prev.rev !== doc.rev) {
      // Новую версию кладём прямо над старой: пока её тайлы не пришли, сквозь неё видна старая.
      // Старую убираем, когда новая догрузилась целиком.
      const rev = doc.rev;
      this.pendingRev = rev;
      this.viewer.addTiledImage({
        tileSource: this.tileSource(doc),
        index: this.baseCount++,
        success: (event) => {
          const item = (event as unknown as ItemEvent).item;
          this.baseItems.set(item, rev);
          const swap = () => this.finishSwap(item, rev);
          if (item.getFullyLoaded()) swap();
          else {
            item.addOnceHandler('fully-loaded-change', swap);
            setTimeout(swap, 8000);
          }
        },
        error: () => this.baseCount--,
      });
    }
  }

  private reset(): void {
    this.base = null;
    this.baseItems.clear();
    this.baseCount = 0;
    this.pendingRev = null;
    this.layers.clear();
    this.deferredRemovals = [];
  }

  private finishSwap(item: OpenSeadragon.TiledImage, rev: number): void {
    // Пока догружалась эта версия, могла прийти ещё более новая — тогда ждём её
    if (!this.doc || rev !== this.doc.rev || !this.baseItems.has(item)) return;
    for (const old of [...this.baseItems.keys()]) {
      if (old === item) continue;
      this.viewer.world.removeItem(old);
      this.baseItems.delete(old);
      this.baseCount--;
    }
    this.base = item;
    this.pendingRev = null;
    for (const it of this.deferredRemovals) this.viewer.world.removeItem(it);
    this.deferredRemovals = [];
    this.redraw();
  }

  private tileSource(doc: DocDto): object {
    const maxLevel = Math.ceil(Math.log2(Math.max(doc.width, doc.height)));
    return {
      width: doc.width,
      height: doc.height,
      tileSize: doc.tileSize,
      tileOverlap: 0,
      maxLevel,
      minLevel: maxLevel - (doc.levels - 1),
      // Тайлы кэшируются навсегда, а rev у каждого документа начинается с 1: без id документа
      // второй открытый файл (или перезапущенный сервер) получал бы из кэша тайлы прежнего
      getTileUrl: (level: number, x: number, y: number) => `/api/doc/tile/${maxLevel - level}/${x}/${y}.jpg?doc=${doc.id}&rev=${doc.rev}`,
    };
  }

  setJobs(jobs: JobDto[], numbers: Map<string, number>, focused: string | null, maskJob: string | null): void {
    this.jobs = jobs;
    this.numbers = numbers;
    this.focused = focused;
    if (maskJob !== this.maskJob) this.pending = [];
    this.maskJob = maskJob;
    this.syncLayers();
  }

  setLayerMask(mask: LayerMaskView | null): void {
    if (mask?.id !== this.layerMask?.id) this.pending = [];
    this.layerMask = mask;
    this.syncLayers();
  }

  /** Мазок не дошёл до сервера — больше не показываем его */
  clearPending(): void {
    this.pending = [];
    this.redraw();
  }

  private maskMode(): boolean {
    return this.maskJob !== null || this.layerMask !== null;
  }

  // Слои поверх холста: варианты задач, маска правимой задачи или правимого слоя
  private syncLayers(): void {
    const jobs = this.jobs;
    const maskJob = this.maskJob;
    const swapPending = this.pendingRev !== null;

    const wanted = new Map<string, { key: string; url: string; rect: RectDto }>();
    for (const job of jobs) {
      if (job.status !== 'done' || !job.inside) continue;
      wanted.set(job.id, {
        key: `${job.selected}:${job.rev}`,
        url: `/api/jobs/${job.id}/layer/${job.selected}.png?rev=${job.rev}`,
        rect: job.inside,
      });
      if (job.id === maskJob) {
        wanted.set(`${job.id}:mask`, { key: String(job.rev), url: `/api/jobs/${job.id}/mask.png?rev=${job.rev}`, rect: job.inside });
      }
    }
    if (this.layerMask) wanted.set('layer:mask', this.layerMask);
    for (const [id, layer] of this.layers) {
      if (wanted.has(id)) continue;
      this.layers.delete(id);
      if (!layer.item) continue;
      // Принятая правка уже в новом холсте — убираем её слой, когда тот догрузится
      if (swapPending) this.deferredRemovals.push(layer.item);
      else this.viewer.world.removeItem(layer.item);
    }
    for (const [id, want] of wanted) {
      const layer = this.layers.get(id);
      if (layer?.key === want.key) continue;
      const next: Layer = { key: want.key };
      this.layers.set(id, next);
      const W = this.doc?.width ?? 1;
      this.viewer.addSimpleImage({
        url: want.url,
        x: want.rect.x / W,
        y: want.rect.y / W,
        width: want.rect.width / W,
        success: (event) => {
          const item = (event as unknown as ItemEvent).item;
          if (this.layers.get(id) !== next) {
            this.viewer.world.removeItem(item);
            return;
          }
          next.item = item;
          if (layer?.item) this.viewer.world.removeItem(layer.item);
          if (id.endsWith(':mask')) this.pending = [];
          this.raiseMasks();
          this.redraw();
        },
      });
    }
    this.redraw();
  }

  // Маска задачи всегда поверх её слоя
  private raiseMasks(): void {
    for (const [id, layer] of this.layers) {
      if (id.endsWith(':mask') && layer.item) {
        this.viewer.world.setItemIndex(layer.item, this.viewer.world.getItemCount() - 1);
      }
    }
  }

  setSelection(shapes: MaskShape[]): void {
    this.selection = shapes;
    this.redraw();
  }

  setTool(tool: Tool): void {
    this.tool = tool;
    this.applyCursor();
    this.redraw();
  }

  setBrush(px: number): void {
    this.brushPx = px;
    this.redraw();
  }

  /** Пробел зажат — временно рука */
  setSpace(held: boolean): void {
    this.spaceHeld = held;
    this.applyCursor();
  }

  fit(): void {
    this.viewer.viewport.goHome();
  }

  showRect(rect: RectDto): void {
    if (!this.base) return;
    const pad = Math.max(rect.width, rect.height) * 0.35;
    const r = new OpenSeadragon.Rect(rect.x - pad, rect.y - pad, rect.width + 2 * pad, rect.height + 2 * pad);
    this.viewer.viewport.fitBounds(this.base.imageToViewportRectangle(r));
  }

  /** Показать область, если её сейчас совсем не видно */
  reveal(rect: RectDto): void {
    if (!this.base) return;
    const view = this.base.viewportToImageRectangle(this.viewer.viewport.getBounds(true));
    const seen = rect.x < view.x + view.width && rect.x + rect.width > view.x && rect.y < view.y + view.height && rect.y + rect.height > view.y;
    if (!seen) this.showRect(rect);
  }

  zoomBy(factor: number): void {
    this.viewer.viewport.zoomBy(factor);
    this.viewer.viewport.applyConstraints();
  }

  zoomTo(percent: number): void {
    if (!this.base) return;
    this.viewer.viewport.zoomTo(this.base.imageToViewportZoom(percent / 100));
  }

  // ——— Рисование ———

  private activeTool(): Tool {
    return this.spaceHeld ? 'hand' : this.tool;
  }

  private applyCursor(): void {
    const tool = this.activeTool();
    this.container.dataset.tool = tool;
  }

  private toImage(position: OpenSeadragon.Point): [number, number] | null {
    if (!this.base) return null;
    const p = this.base.viewerElementToImageCoordinates(position);
    return [round(p.x), round(p.y)];
  }

  /** Сколько экранных пикселей в одном пикселе холста */
  private scale(): number {
    if (!this.base) return 1;
    const o = this.base.imageToViewerElementCoordinates(new OpenSeadragon.Point(0, 0));
    const p = this.base.imageToViewerElementCoordinates(new OpenSeadragon.Point(1000, 0));
    return (p.x - o.x) / 1000;
  }

  private press(position: OpenSeadragon.Point, original: MouseEvent): void {
    const tool = this.activeTool();
    if (tool === 'hand') return;
    const p = this.toImage(position);
    if (!p) return;
    this.draft = {
      kind: tool === 'rect' ? 'rect' : tool === 'lasso' ? 'lasso' : 'stroke',
      points: [p],
      erase: tool === 'eraser' || original.altKey,
      size: round(this.brushPx / this.scale()),
    };
    this.redraw();
  }

  private move(position: OpenSeadragon.Point): void {
    const draft = this.draft;
    const p = this.toImage(position);
    if (!draft || !p) return;
    if (draft.kind === 'rect') {
      draft.points = [draft.points[0]!, p];
    } else {
      const last = draft.points[draft.points.length - 1]!;
      const minStep = 2 / this.scale();
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= minStep) draft.points.push(p);
    }
    this.redraw();
  }

  private release(): void {
    const draft = this.draft;
    this.draft = null;
    if (!draft) return;
    const erase = draft.erase || undefined;
    const pts = draft.points;
    const minSize = 3 / this.scale();
    let shape: MaskShape | null = null;
    if (draft.kind === 'rect' && pts.length >= 2) {
      const [a, b] = [pts[0]!, pts[pts.length - 1]!];
      const width = round(Math.abs(b[0] - a[0]));
      const height = round(Math.abs(b[1] - a[1]));
      if (width > minSize && height > minSize) shape = { kind: 'rect', x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), width, height, erase };
    } else if (draft.kind === 'lasso' && pts.length >= 3) {
      shape = { kind: 'polygon', points: pts, erase };
    } else if (draft.kind === 'stroke') {
      const first = pts[0]!;
      shape = { kind: 'stroke', points: pts.length > 1 ? pts : [first, [first[0] + 0.1, first[1]]], size: draft.size, erase };
    }
    if (shape && this.maskMode()) this.pending.push(shape);
    this.redraw();
    if (shape) this.hooks.onShape(shape);
  }

  private reportZoom(): void {
    if (!this.base) return;
    this.hooks.onZoom(Math.round(this.base.viewportToImageZoom(this.viewer.viewport.getZoom(true)) * 100));
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const { clientWidth: w, clientHeight: h } = this.container;
    for (const c of [this.overlay, this.fill, this.edge]) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    this.overlay.style.width = `${w}px`;
    this.overlay.style.height = `${h}px`;
    this.redraw();
  }

  private redraw(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  private draw(): void {
    const ctx = this.overlay.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    if (!this.base) return;
    const dpr = window.devicePixelRatio || 1;
    const o = this.base.imageToViewerElementCoordinates(new OpenSeadragon.Point(0, 0));
    const s = this.scale();
    const toImage = (c: CanvasRenderingContext2D) => c.setTransform(dpr * s, 0, 0, dpr * s, dpr * o.x, dpr * o.y);

    // Выделение: объединение фигур с вычитанием ластика — на отдельном канвасе, затем заливка и контур.
    // Пока правится маска, выделение не показываем, чтобы не путать одно с другим: видны только мазки по маске,
    // и стирающие — красным, иначе ластик на пустом канвасе не оставлял бы следа
    const maskMode = this.maskMode();
    const shapes: (MaskShape | Draft)[] = maskMode ? [...this.pending] : [...this.selection];
    if (this.draft) shapes.push(this.draft);
    if (shapes.length) {
      const f = this.fill.getContext('2d')!;
      f.setTransform(1, 0, 0, 1, 0, 0);
      f.clearRect(0, 0, this.fill.width, this.fill.height);
      toImage(f);
      for (const shape of shapes) {
        f.globalCompositeOperation = shape.erase && !maskMode ? 'destination-out' : 'source-over';
        const color = shape.erase ? ERROR : ACCENT;
        const path = shapePath(shape);
        if (shape.kind === 'stroke') {
          f.lineCap = 'round';
          f.lineJoin = 'round';
          f.lineWidth = shape.size;
          f.strokeStyle = color;
          f.stroke(path);
        } else {
          f.fillStyle = color;
          f.fill(path);
        }
      }
      f.globalCompositeOperation = 'source-over';
      // Контур: копия заливки минус она же, сдвинутая на 1,5 px в четыре стороны
      const e = this.edge.getContext('2d')!;
      e.setTransform(1, 0, 0, 1, 0, 0);
      e.globalCompositeOperation = 'source-over';
      e.clearRect(0, 0, this.edge.width, this.edge.height);
      e.drawImage(this.fill, 0, 0);
      e.globalCompositeOperation = 'destination-out';
      const d = 1.5 * dpr;
      for (const [dx, dy] of [[d, 0], [-d, 0], [0, d], [0, -d]] as const) e.drawImage(this.fill, dx, dy);
      ctx.globalAlpha = maskMode ? 0.4 : 0.32;
      ctx.drawImage(this.fill, 0, 0);
      ctx.globalAlpha = 1;
      ctx.drawImage(this.edge, 0, 0);
    }

    // Области задач с номерами, как в очереди, и границы правимого слоя: за ними маску не расширить
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = '600 12px "Golos Text Variable", system-ui, sans-serif';
    const frame = (r: RectDto, label: string, color: string, width: number, dash: number[]) => {
      const x = o.x + r.x * s;
      const y = o.y + r.y * s;
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.setLineDash(dash);
      ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(r.width * s), Math.round(r.height * s));
      ctx.setLineDash([]);
      const w = ctx.measureText(label).width + 12;
      ctx.fillStyle = color;
      ctx.fillRect(Math.round(x), Math.round(y) - 20, w, 20);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, Math.round(x) + 6, Math.round(y) - 6);
    };
    for (const job of this.jobs) {
      const r = job.inside ?? job.bbox;
      if (!r) continue;
      const color = job.status === 'error' ? ERROR : ACCENT;
      frame(r, `#${this.numbers.get(job.id) ?? '?'}`, color, job.id === this.focused ? 2 : 1, job.status === 'done' ? [] : [6, 4]);
    }
    if (this.layerMask) frame(this.layerMask.rect, 'Маска слоя', ACCENT, 2, [6, 4]);

    // Курсор кисти
    const tool = this.activeTool();
    if (this.cursor && (tool === 'brush' || tool === 'eraser')) {
      ctx.beginPath();
      ctx.arc(this.cursor.x, this.cursor.y, this.brushPx / 2, 0, Math.PI * 2);
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.stroke();
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = tool === 'eraser' ? '#fff' : ACCENT;
      ctx.stroke();
    }
  }
}
