// Просмотр холста: OpenSeadragon тянет тайлы с сервера, поверх — канвас размером с экран
// для выделения, наброска для модели, контуров задач, курсора кисти, объекта под курсором и превью правки маски (mask-edit.ts).
// Фигуры и штрихи хранятся в координатах холста, поэтому большой canvas в браузере не нужен ни для какой операции;
// маски объектов приходят с сервера картинками. Сдвиг отделённого объекта виден сразу: сервер отдаёт картинки объекта и холста под ним.
import OpenSeadragon from 'openseadragon';
import { API_HEADER, type DocDto, type JobDto, type MaskEditResult, type MaskShape, type RectDto, type SketchStroke } from '../shared/api.ts';
import { post } from './api.ts';
import { MaskPreview, type MaskEditView } from './mask-edit.ts';

export type Tool = 'hand' | 'rect' | 'lasso' | 'brush' | 'eraser' | 'sketch' | 'object' | 'move';

/** Что фигура делает с выделением: заменяет его, добавляется к нему или вычитается */
export type SelectOp = 'new' | 'add' | 'sub';

/** Слой, который можно сдвинуть: его версия на холсте (layer) и где она лежит, hit — где за слой можно взяться */
export interface Movable {
  id: string;
  layer: string;
  rect: RectDto;
  hit: RectDto;
}

/** Сдвиг объекта: пока тянут, и после — пока холст не догонит */
interface Shift {
  item: Movable;
  start: [number, number];
  dx: number;
  dy: number;
  /** Холст под объектом и сам объект — картинками, загруженными, когда начали тянуть */
  below: HTMLImageElement;
  cutout: HTMLImageElement;
  /** Номер маски объекта в выделении, когда начали тянуть: пока сервер не прислал новую, её сдвигаем сами */
  rev?: number;
  /** Холст с этим номером уже показывает сдвиг; до ответа сервера — бесконечность */
  settleRev: number;
  until: number;
}

/** Маска объекта в выделении */
export type MaskRef = Extract<MaskShape, { kind: 'mask' }>;

/** Щелчок или рамка «Палочкой» */
export interface PickEvent {
  point?: [number, number];
  box?: RectDto;
  op: SelectOp;
  /** Видимая часть холста */
  view: RectDto;
  /** Сколько пикселей холста в экранном пикселе: щёлкнули ли в то же место */
  imagePx: number;
}

const ACCENT = '#2F5BEA';
const ERROR = '#C8431A';
/** Рамка куска, который уйдёт модели */
const MODEL_FRAME = '#5F6672';
/** Сколько картинок масок объектов держать готовыми; маски выделения — сверх этого, их не выбрасываем */
const MASK_IMAGES_KEPT = 40;

export type { MaskEditView };

/** Превью правки, которую уже закончили, держится не дольше этого, даже если холст так и не догнал мазки */
const SETTLE_TIMEOUT = 5000;

export interface ViewerHooks {
  /** Фигура выделения и что она делает с ним */
  onShape(shape: MaskShape, op: SelectOp): void;
  /** Штрих наброска для модели */
  onSketch(stroke: SketchStroke): void;
  /** Мазок по маске слоя или задачи: отправить на сервер */
  onMaskShape(view: MaskEditView, shape: MaskShape): Promise<MaskEditResult>;
  /** Щелчок или рамка «Палочкой» */
  onPick(event: PickEvent): void;
  /** Отделённый объект сдвинули: номер холста после сдвига */
  onMove(objectId: string, dx: number, dy: number): Promise<number>;
  onZoom(percent: number): void;
}

interface Draft {
  kind: 'rect' | 'lasso' | 'stroke';
  points: [number, number][];
  erase: boolean;
  size: number;
  softness: number;
  /** Мазок сразу виден в превью маски — черновик поверх рисовать не нужно */
  live?: boolean;
  /** Штрих наброска этим цветом, а не фигура выделения */
  sketch?: string;
  /** Щелчок или рамка «Палочки» (рамка — объект внутри неё) */
  pick?: boolean;
  /** Что фигура сделает с выделением */
  op?: SelectOp;
}

type ItemEvent = { item: OpenSeadragon.TiledImage };

function round(v: number): number {
  return Math.round(v * 10) / 10;
}

/** Линия по точкам; точка — отрезок нулевой длины, со скруглёнными концами он рисуется кружком */
function linePath(points: [number, number][]): Path2D {
  const path = new Path2D();
  const [x0, y0] = points[0]!;
  path.moveTo(x0, y0);
  if (points.length === 1) path.lineTo(x0, y0);
  for (const [x, y] of points.slice(1)) path.lineTo(x, y);
  return path;
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
  /** Набросок рисуется отдельно: его ластик стирает только набросок */
  private readonly ink = document.createElement('canvas');
  private readonly hooks: ViewerHooks;

  private doc: DocDto | null = null;
  private base: OpenSeadragon.TiledImage | null = null;
  private readonly baseItems = new Map<OpenSeadragon.TiledImage, number>();
  /** Сколько версий холста лежит в мире или добавляется — все они внизу, под слоями задач */
  private baseCount = 0;
  /** Версия холста, которая догружается; пока она есть, слои принятых правок не убираем */
  private pendingRev: number | null = null;
  /** Исходник поверх холста, пока держат «\\» */
  private compare: OpenSeadragon.TiledImage | null = null;
  private comparing = false;

  private tool: Tool = 'rect';
  /** Режим выделения на панели инструмента; Shift и Alt меняют его на время щелчка */
  private selectMode: SelectOp = 'new';
  private spaceHeld = false;
  private brushPx = 40;
  /** Мягкость края кисти 0..1; действует только при правке маски — выделение всегда с жёстким краем */
  private softness = 0;
  private selection: MaskShape[] = [];
  private sketch: SketchStroke[] = [];
  private sketchPx = 10;
  private sketchColor = '#ff3b30';
  private jobs: JobDto[] = [];
  private numbers = new Map<string, number>();
  private focused: string | null = null;
  /** Правка маски слоя или задачи: участок показывает превью, кисть меняет его сразу */
  private edit: MaskPreview | null = null;
  /** Законченная правка: её превью видно, пока холст или слой задачи не догонят последние мазки */
  private closing: { preview: MaskPreview; until: number } | null = null;
  private draft: Draft | null = null;
  private cursor: { x: number; y: number } | null = null;
  private frame = 0;
  /** Модель выделения объектов готова: можно подсвечивать объект под курсором */
  private segmentReady = false;
  /** Объект под курсором: маска с сервера и где она лежит на холсте */
  private hover: { bitmap: ImageBitmap; rect: RectDto } | null = null;
  /** Где курсор на холсте, пока выбрана «Палочка» */
  private hoverAt: [number, number] | null = null;
  private hoverBusy = false;
  /** Растёт, когда подсветка больше не нужна: опоздавший ответ её не вернёт */
  private hoverSeq = 0;
  /** Объект, на который навели в списке объектов */
  private highlight: MaskRef | null = null;
  /** Слой, в котором работают: всё вокруг притушено, подсветка под курсором — только в нём */
  private layer: MaskRef | null = null;
  /** Кусок холста, который увидит модель */
  private modelFrame: RectDto | null = null;
  /** Маски объектов, перекрашенные в цвет выделения; null — ещё грузится */
  private readonly maskImages = new Map<string, HTMLCanvasElement | null>();
  private prepareTimer = 0;
  /** Вид, для которого сервер уже считает признаки */
  private prepared = '';
  /** Отделённые объекты снизу вверх, как их слои в стопке */
  private movable: Movable[] = [];
  private shift: Shift | null = null;
  /** Картинки для сдвига, загруженные заранее: тянуть можно сразу */
  private readonly moveImages = new Map<string, HTMLImageElement>();

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
      // Свои клавиши OpenSeadragon (R поворачивает, W/A/S/D двигают, F отражает) спорят с клавишами инструментов
      keyboardNavEnabled: false,
      gestureSettingsMouse: { clickToZoom: false, dblClickToZoom: true, flickEnabled: false },
    });

    this.overlay = document.createElement('canvas');
    this.overlay.className = 'stage-overlay';
    container.appendChild(this.overlay);
    new ResizeObserver(() => this.resize()).observe(container);

    this.viewer.addHandler('canvas-press', (e) => this.press(e.position, e.originalEvent as MouseEvent));
    this.viewer.addHandler('canvas-drag', (e) => {
      if (!this.draft && !this.dragging()) return;
      e.preventDefaultAction = true;
      this.move(e.position);
    });
    this.viewer.addHandler('canvas-release', () => this.release());
    // При движении картинки поверх рисуем в том же кадре, что и тайлы: превью маски непрозрачно и иначе отставало бы от них
    this.viewer.addHandler('animation', () => this.drawNow());
    this.viewer.addHandler('update-viewport', () => this.drawNow());
    this.viewer.addHandler('animation', () => this.reportZoom());
    this.viewer.addHandler('animation-finish', () => {
      this.reportZoom();
      this.schedulePrepare();
    });
    this.viewer.addHandler('open', () => {
      this.base = this.viewer.world.getItemAt(0);
      if (this.base && this.doc) this.baseItems.set(this.base, this.doc.rev);
      this.reportZoom();
      this.schedulePrepare();
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
      if (this.tool === 'brush' || this.tool === 'eraser' || this.tool === 'sketch') this.redraw();
      if (this.activeTool() === 'object' && !this.draft) {
        this.hoverAt = this.toImage(new OpenSeadragon.Point(this.cursor.x, this.cursor.y));
        this.requestHover();
      }
      if (this.activeTool() === 'move') {
        const p = this.toImage(new OpenSeadragon.Point(this.cursor.x, this.cursor.y));
        const over = this.dragging() || (!!p && !!this.movableAt(p));
        if (over !== (this.container.dataset.over === '1')) this.container.dataset.over = over ? '1' : '';
      }
    });
    container.addEventListener('pointerleave', () => {
      this.cursor = null;
      this.clearHover();
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
      this.schedulePrepare();
      this.preloadMove();
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
    this.closing?.preview.dispose();
    this.closing = null;
    this.shift = null;
    this.moveImages.clear();
    this.clearHover();
    this.maskImages.clear();
    this.prepared = '';
    this.base = null;
    this.baseItems.clear();
    this.baseCount = 0;
    this.pendingRev = null;
    this.compare = null;
    this.comparing = false;
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

  setJobs(jobs: JobDto[], numbers: Map<string, number>, focused: string | null): void {
    this.jobs = jobs;
    this.numbers = numbers;
    this.focused = focused;
    this.redraw();
  }

  /** Правка маски слоя или задачи; null — правку закончили */
  setMaskEdit(view: MaskEditView | null): void {
    const key = view && `${view.kind}:${view.target}`;
    if (view && this.edit?.key === key) {
      this.edit.update(view);
      return;
    }
    if (this.edit) {
      this.closing?.preview.dispose();
      this.closing = null;
      if (this.edit.ready) {
        this.closing = { preview: this.edit, until: Date.now() + SETTLE_TIMEOUT };
        setTimeout(() => this.redraw(), SETTLE_TIMEOUT + 50);
      } else {
        this.edit.dispose();
      }
    }
    this.edit = view ? new MaskPreview(view, () => this.redraw()) : null;
    this.redraw();
  }

  /** Маску правимого слоя или задачи поменяли не мазки (отмена, «Расширить по правке»): превью перезапросит её */
  maskChanged(): void {
    this.edit?.markStale();
  }

  private maskMode(): boolean {
    return this.edit !== null;
  }

  /** Холст или слой задачи уже показывают всё, что нарисовали в законченной правке */
  private settled(preview: MaskPreview): boolean {
    if (preview.inflight > 0) return false;
    return this.pendingRev === null && (this.doc?.rev ?? 0) >= preview.settleRev;
  }

  /** Пока держат «\\» — исходник всей картинки поверх холста */
  setCompare(on: boolean): void {
    this.comparing = on;
    if (!on) {
      if (this.compare) this.viewer.world.removeItem(this.compare);
      this.compare = null;
      return;
    }
    const doc = this.doc;
    if (!doc || this.compare) return;
    this.viewer.addTiledImage({
      tileSource: { ...this.tileSource(doc), getTileUrl: (level: number, x: number, y: number) => this.baseTileUrl(doc, level, x, y) } as object,
      success: (event) => {
        const item = (event as unknown as ItemEvent).item;
        if (!this.comparing || this.doc?.id !== doc.id || this.compare) this.viewer.world.removeItem(item);
        else this.compare = item;
      },
    });
  }

  private baseTileUrl(doc: DocDto, level: number, x: number, y: number): string {
    const maxLevel = Math.ceil(Math.log2(Math.max(doc.width, doc.height)));
    return `/api/doc/base/${maxLevel - level}/${x}/${y}.jpg?doc=${doc.id}`;
  }

  setSelection(shapes: MaskShape[]): void {
    this.selection = shapes;
    this.redraw();
  }

  setSketch(strokes: SketchStroke[]): void {
    this.sketch = strokes;
    this.redraw();
  }

  /** Толщина штриха наброска на экране и его цвет */
  setSketchBrush(px: number, color: string): void {
    this.sketchPx = px;
    this.sketchColor = color;
    this.redraw();
  }

  setTool(tool: Tool): void {
    this.tool = tool;
    this.applyCursor();
    this.preloadMove();
    if (tool !== 'object') this.clearHover();
    this.schedulePrepare();
    this.redraw();
  }

  setSelectMode(mode: SelectOp): void {
    this.selectMode = mode;
  }

  /** Что щелчок или фигура сделают с выделением: Alt — вычесть, Shift (и ⌘) — добавить, иначе режим с панели. Кисть не заменяет */
  private opFor(e: MouseEvent, brush = false): SelectOp {
    if (e.altKey) return 'sub';
    if (e.shiftKey || e.metaKey || e.ctrlKey) return 'add';
    return brush && this.selectMode === 'new' ? 'add' : this.selectMode;
  }

  /** Отделённые объекты, которые можно сдвинуть, снизу вверх */
  setMovable(items: Movable[]): void {
    this.movable = items;
    this.preloadMove();
    this.redraw();
  }

  /** Верхний отделённый объект под точкой холста */
  private movableAt(p: [number, number]): Movable | undefined {
    return this.movable.findLast(({ hit: r }) => p[0] >= r.x && p[1] >= r.y && p[0] < r.x + r.width && p[1] < r.y + r.height);
  }

  /** Тянут объект прямо сейчас */
  private dragging(): boolean {
    return !!this.shift && this.shift.settleRev === Infinity && this.shift.until === Infinity;
  }

  /** Картинки объекта и холста под ним — для превью сдвига; меняются вместе с холстом */
  private moveUrls(item: Movable): [string, string] {
    const q = `doc=${this.doc?.id}&rev=${this.doc?.rev}`;
    return [`/api/history/${item.layer}/edit/below.jpg?${q}`, `/api/history/${item.layer}/cutout.png?${q}`];
  }

  private moveImage(url: string): HTMLImageElement {
    let img = this.moveImages.get(url);
    if (!img) {
      img = new Image();
      img.onload = () => this.redraw();
      img.src = url;
      this.moveImages.set(url, img);
      while (this.moveImages.size > MASK_IMAGES_KEPT) this.moveImages.delete(this.moveImages.keys().next().value!);
    }
    return img;
  }

  /** С инструментом «Сдвинуть» картинки грузятся заранее: тянуть можно сразу */
  private preloadMove(): void {
    if (this.tool !== 'move' || !this.doc) return;
    for (const item of this.movable) for (const url of this.moveUrls(item)) this.moveImage(url);
  }

  /** Модель выделения объектов готова — можно считать признаки вида и подсвечивать объект под курсором */
  setSegmentReady(ready: boolean): void {
    this.segmentReady = ready;
    if (!ready) this.clearHover();
    this.schedulePrepare();
  }

  /** Обвести объект, на который навели в списке объектов */
  setHighlight(shape: MaskRef | null): void {
    this.highlight = shape;
    this.redraw();
  }

  /** Работа в слое: маска слоя или null — вся картинка */
  setLayer(shape: MaskRef | null): void {
    this.layer = shape;
    this.clearHover();
    this.redraw();
  }

  /** Кусок холста, который уйдёт модели с выделением; null — выделения нет */
  setModelFrame(rect: RectDto | null): void {
    this.modelFrame = rect;
    this.redraw();
  }

  /** Видимая часть холста целыми пикселями; null — холста не видно */
  visibleRect(current = true): RectDto | null {
    if (!this.base || !this.doc) return null;
    const r = this.base.viewportToImageRectangle(this.viewer.viewport.getBounds(current));
    const x0 = Math.max(0, Math.floor(r.x));
    const y0 = Math.max(0, Math.floor(r.y));
    const x1 = Math.min(this.doc.width, Math.ceil(r.x + r.width));
    const y1 = Math.min(this.doc.height, Math.ceil(r.y + r.height));
    if (x1 - x0 < 16 || y1 - y0 < 16) return null;
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }

  private objectTool(): boolean {
    return this.activeTool() === 'object' && this.segmentReady && !this.maskMode();
  }

  /** Вид остановился: пусть сервер заранее посчитает признаки видимой части — тогда подсветка и щелчок сразу */
  private schedulePrepare(): void {
    window.clearTimeout(this.prepareTimer);
    this.prepareTimer = window.setTimeout(() => {
      const view = this.objectTool() ? this.visibleRect(false) : null;
      const key = view && `${this.doc?.id}:${this.doc?.rev}:${view.x},${view.y},${view.width},${view.height}`;
      if (!view || key === this.prepared) return;
      this.prepared = key!;
      post('/api/segment/view', { view }).catch(() => {
        if (this.prepared === key) this.prepared = '';
      });
    }, 200);
  }

  private clearHover(): void {
    this.hoverSeq++;
    this.hoverAt = null;
    this.hover?.bitmap.close();
    this.hover = null;
  }

  /** Объект под курсором — не больше одного запроса разом; пока он шёл, курсор сдвинулся — следующий */
  private requestHover(): void {
    const at = this.hoverAt;
    const view = this.visibleRect();
    if (this.hoverBusy || !at || !view || !this.objectTool() || this.draft) return;
    this.hoverBusy = true;
    const seq = this.hoverSeq;
    const within = this.layer ? `&within=${encodeURIComponent(this.layer.id.slice('obj:'.length))}` : '';
    const q = `x=${at[0]}&y=${at[1]}&vx=${view.x}&vy=${view.y}&vw=${view.width}&vh=${view.height}${within}`;
    fetch(`/api/segment/hover.png?${q}`)
      .then(async (res) => {
        const r = res.headers.get(`${API_HEADER}-rect`)?.split(',').map(Number);
        if (res.status !== 200 || r?.length !== 4) return null;
        return { bitmap: await createImageBitmap(await res.blob()), rect: { x: r[0]!, y: r[1]!, width: r[2]!, height: r[3]! } };
      })
      .catch(() => null)
      .then((hit) => {
        this.hoverBusy = false;
        if (seq !== this.hoverSeq) {
          hit?.bitmap.close();
          return;
        }
        this.hover?.bitmap.close();
        this.hover = hit;
        this.redraw();
        if (this.hoverAt !== at) this.requestHover();
      });
  }

  private maskUrl(shape: MaskRef): string {
    return `/api/masks/${encodeURIComponent(shape.id)}.png?doc=${this.doc?.id}&rev=${shape.rev ?? 0}`;
  }

  /** Маска объекта, перекрашенная в цвет выделения; пока не пришла — null */
  private maskImage(shape: MaskRef): HTMLCanvasElement | null {
    const url = this.maskUrl(shape);
    if (this.maskImages.has(url)) {
      const img = this.maskImages.get(url)!;
      this.maskImages.delete(url);
      this.maskImages.set(url, img);
      return img;
    }
    void this.loadMask(shape);
    return null;
  }

  /** Загрузить маску объекта заранее: выделение меняют на неё, только когда она готова, — так оно не мигает */
  loadMask(shape: MaskRef): Promise<void> {
    const url = this.maskUrl(shape);
    if (this.maskImages.get(url)) return Promise.resolve();
    this.maskImages.set(url, null);
    // Выбрасываются самые давние, кроме масок, которые сейчас в выделении, подсветке и слое: иначе при большом выделении
    // они выбрасывали бы друг друга и часть выделения не рисовалась
    if (this.maskImages.size > MASK_IMAGES_KEPT) {
      const used = new Set([...this.selection, ...(this.highlight ? [this.highlight] : []), ...(this.layer ? [this.layer] : [])].flatMap((s) => (s.kind === 'mask' ? [this.maskUrl(s)] : [])));
      for (const key of [...this.maskImages.keys()]) {
        if (this.maskImages.size <= MASK_IMAGES_KEPT) break;
        if (key !== url && !used.has(key)) this.maskImages.delete(key);
      }
    }
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        if (this.maskImages.has(url)) {
          const c = document.createElement('canvas');
          c.width = img.naturalWidth;
          c.height = img.naturalHeight;
          const g = c.getContext('2d')!;
          g.drawImage(img, 0, 0);
          g.globalCompositeOperation = 'source-in';
          g.fillStyle = ACCENT;
          g.fillRect(0, 0, c.width, c.height);
          this.maskImages.set(url, c);
          this.redraw();
        }
        resolve();
      };
      img.onerror = () => {
        this.maskImages.delete(url);
        resolve();
      };
      img.src = url;
    });
  }

  setBrush(px: number, softness: number): void {
    this.brushPx = px;
    this.softness = softness;
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
    if (tool === 'move') {
      // Мимо отделённых объектов — картинку двигает OpenSeadragon, как рукой
      const item = this.movableAt(p);
      if (!item || this.maskMode()) return;
      const [below, cutout] = this.moveUrls(item).map((url) => this.moveImage(url)) as [HTMLImageElement, HTMLImageElement];
      const rev = this.selection.find((sh) => sh.kind === 'mask' && sh.id === `obj:${item.id}`) as MaskRef | undefined;
      this.shift = { item, start: p, dx: 0, dy: 0, below, cutout, rev: rev?.rev, settleRev: Infinity, until: Infinity };
      this.redraw();
      return;
    }
    if (tool === 'object') {
      // «Палочка»: щелчок — объект под ним, рамка — объект внутри неё
      if (!this.objectTool()) return;
      this.clearHover();
      const op = this.opFor(original);
      this.draft = { kind: 'rect', points: [p], erase: op === 'sub', op, size: 0, softness: 0, pick: true };
      this.redraw();
      return;
    }
    if (tool === 'sketch') {
      // Набросок — для новой правки; пока правят маску, кисть меняет маску
      if (this.maskMode()) return;
      this.draft = { kind: 'stroke', points: [p], erase: original.altKey, size: round(this.sketchPx / this.scale()), softness: 0, sketch: this.sketchColor };
      this.redraw();
      return;
    }
    const kind = tool === 'rect' ? 'rect' : tool === 'lasso' ? 'lasso' : 'stroke';
    // У маски слоя или задачи кисть дорисовывает, ластик и Alt стирают; у выделения — режим с панели, ластик вычитает
    const op: SelectOp = tool === 'eraser' ? 'sub' : this.opFor(original, kind === 'stroke');
    const draft: Draft = {
      kind,
      points: [p],
      erase: this.maskMode() ? tool === 'eraser' || original.altKey : op === 'sub',
      op,
      size: round(this.brushPx / this.scale()),
      softness: this.maskMode() ? this.softness : 0,
    };
    if (draft.kind === 'stroke' && this.edit) draft.live = this.edit.begin(p, draft.size, draft.softness, draft.erase);
    this.draft = draft;
    this.redraw();
  }

  private move(position: OpenSeadragon.Point): void {
    const draft = this.draft;
    const p = this.toImage(position);
    if (p && this.shift && this.dragging()) {
      // Целыми пикселями и так, чтобы объект остался на холсте, — как сдвинет сервер
      const { rect } = this.shift.item;
      const W = this.doc?.width ?? 0;
      const H = this.doc?.height ?? 0;
      this.shift.dx = Math.min(Math.max(-rect.x, Math.round(p[0] - this.shift.start[0])), W - rect.x - rect.width);
      this.shift.dy = Math.min(Math.max(-rect.y, Math.round(p[1] - this.shift.start[1])), H - rect.y - rect.height);
      this.redraw();
      return;
    }
    if (!draft || !p) return;
    if (draft.kind === 'rect') {
      draft.points = [draft.points[0]!, p];
    } else {
      const last = draft.points[draft.points.length - 1]!;
      const minStep = 2 / this.scale();
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= minStep) {
        draft.points.push(p);
        if (draft.live) this.edit?.extend(p);
      }
    }
    this.redraw();
  }

  private release(): void {
    if (this.shift && this.dragging()) {
      const shift = this.shift;
      if (!shift.dx && !shift.dy) {
        this.shift = null;
        this.redraw();
        return;
      }
      // Превью держится, пока холст не покажет сдвиг сам
      shift.until = Date.now() + SETTLE_TIMEOUT;
      setTimeout(() => this.redraw(), SETTLE_TIMEOUT + 50);
      this.hooks
        .onMove(shift.item.id, shift.dx, shift.dy)
        .then((rev) => {
          shift.settleRev = rev;
        })
        .catch(() => {
          if (this.shift === shift) this.shift = null;
        })
        .finally(() => this.redraw());
      return;
    }
    const draft = this.draft;
    this.draft = null;
    if (!draft) return;
    const erase = draft.erase || undefined;
    const pts = draft.points;
    if (draft.pick) {
      this.redraw();
      const view = this.visibleRect();
      if (!view) return;
      const [a, b] = [pts[0]!, pts[pts.length - 1]!];
      const imagePx = 1 / this.scale();
      const dragged = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])) > 6 * imagePx;
      const box = { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), width: Math.abs(b[0] - a[0]), height: Math.abs(b[1] - a[1]) };
      this.hooks.onPick({ ...(dragged ? { box } : { point: a }), op: draft.op ?? 'new', view, imagePx });
      return;
    }
    if (draft.sketch) {
      this.redraw();
      this.hooks.onSketch({ points: pts, size: draft.size, color: draft.sketch, erase });
      return;
    }
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
      const softness = draft.softness || undefined;
      shape = { kind: 'stroke', points: pts.length > 1 ? pts : [first, [first[0] + 0.1, first[1]]], size: draft.size, softness, erase };
    }
    const edit = this.edit;
    if (draft.live) edit?.end();
    this.redraw();
    if (!shape) return;
    if (!edit) {
      this.hooks.onShape(shape, draft.op ?? 'add');
      return;
    }
    const applied = draft.live || edit.fill(shape);
    const view = edit.view;
    edit.send(shape, applied, (s) => this.hooks.onMaskShape(view, s));
  }

  private reportZoom(): void {
    if (!this.base) return;
    this.hooks.onZoom(Math.round(this.base.viewportToImageZoom(this.viewer.viewport.getZoom(true)) * 100));
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const { clientWidth: w, clientHeight: h } = this.container;
    for (const c of [this.overlay, this.fill, this.edge, this.ink]) {
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

  private drawNow(): void {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.draw();
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
    const f = this.fill.getContext('2d')!;
    const e = this.edge.getContext('2d')!;
    // Контур снаружи заливки: она же, сдвинутая на 1,5 px в четыре стороны, минус сама заливка
    const outline = () => {
      e.setTransform(1, 0, 0, 1, 0, 0);
      e.globalCompositeOperation = 'source-over';
      e.clearRect(0, 0, this.edge.width, this.edge.height);
      const d = 1.5 * dpr;
      for (const [dx, dy] of [[d, 0], [-d, 0], [0, d], [0, -d]] as const) e.drawImage(this.fill, dx, dy);
      e.globalCompositeOperation = 'destination-out';
      e.drawImage(this.fill, 0, 0);
      e.globalCompositeOperation = 'source-over';
    };

    // Правка маски: участок таким, каким он станет, и контур маски вместо заливки — её не путать с самой картинкой
    if (this.closing && (this.settled(this.closing.preview) || Date.now() > this.closing.until)) {
      this.closing.preview.dispose();
      this.closing = null;
    }
    const preview = this.edit?.ready ? this.edit : this.closing?.preview;
    if (preview) {
      toImage(ctx);
      preview.draw(ctx);
    }
    if (preview && preview === this.edit) {
      const { x, y, width, height } = preview.view.rect;
      f.setTransform(1, 0, 0, 1, 0, 0);
      f.globalCompositeOperation = 'source-over';
      f.clearRect(0, 0, this.fill.width, this.fill.height);
      toImage(f);
      f.drawImage(preview.outline, x, y, width, height);
      f.setTransform(1, 0, 0, 1, 0, 0);
      f.globalCompositeOperation = 'source-in';
      f.fillStyle = ACCENT;
      f.fillRect(0, 0, this.fill.width, this.fill.height);
      f.globalCompositeOperation = 'source-over';
      outline();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(this.edge, 0, 0);
    }

    // Сдвиг объекта: на прежнем месте — холст под ним, сам он — на новом
    const shift = this.shift;
    if (shift && !this.dragging() && ((this.pendingRev === null && (this.doc?.rev ?? 0) >= shift.settleRev) || Date.now() > shift.until)) {
      this.shift = null;
    } else if (shift && shift.below.complete && shift.cutout.complete && shift.below.naturalWidth && shift.cutout.naturalWidth) {
      const r = shift.item.rect;
      toImage(ctx);
      ctx.drawImage(shift.below, r.x, r.y, r.width, r.height);
      ctx.drawImage(shift.cutout, r.x + shift.dx, r.y + shift.dy, r.width, r.height);
    }
    const moved = this.shift;
    const maskMode = this.maskMode();

    // Работа в слое: картинка вокруг него притушена
    const scope = this.layer && !maskMode && this.doc ? this.maskImage(this.layer) : null;
    if (scope && this.layer && this.doc) {
      f.setTransform(1, 0, 0, 1, 0, 0);
      f.globalCompositeOperation = 'source-over';
      f.clearRect(0, 0, this.fill.width, this.fill.height);
      toImage(f);
      f.fillStyle = 'rgba(0, 0, 0, 0.45)';
      f.fillRect(0, 0, this.doc.width, this.doc.height);
      f.globalCompositeOperation = 'destination-out';
      const [dx, dy] = moved && this.layer.id === `obj:${moved.item.id}` ? [moved.dx, moved.dy] : [0, 0];
      f.drawImage(scope, this.layer.x + dx, this.layer.y + dy, this.layer.width, this.layer.height);
      f.globalCompositeOperation = 'source-over';
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(this.fill, 0, 0);
    }

    // Выделение: объединение фигур с вычитанием ластика — на отдельном канвасе, затем заливка и контур.
    // Пока правится маска, выделение не показываем, чтобы не путать одно с другим. Мазок по маске виден сразу
    // в превью; черновик — только у прямоугольника и лассо (и пока превью грузится), стирающий — красным
    const shapes: (MaskShape | Draft)[] = maskMode ? [] : [...this.selection];
    if (this.draft && !this.draft.live && !this.draft.sketch && !this.draft.pick) shapes.push(this.draft);
    if (shapes.length) {
      f.setTransform(1, 0, 0, 1, 0, 0);
      f.clearRect(0, 0, this.fill.width, this.fill.height);
      toImage(f);
      for (const shape of shapes) {
        f.globalCompositeOperation = shape.erase && !maskMode ? 'destination-out' : 'source-over';
        if (shape.kind === 'mask') {
          const img = this.maskImage(shape);
          // Сдвигаемый объект в выделении едет вместе с ним
          const [dx, dy] = moved && shape.id === `obj:${moved.item.id}` && shape.rev === moved.rev ? [moved.dx, moved.dy] : [0, 0];
          if (img) f.drawImage(img, shape.x + dx, shape.y + dy, shape.width, shape.height);
          continue;
        }
        const color = shape.erase ? ERROR : ACCENT;
        const path = shapePath(shape);
        if (shape.kind === 'stroke') {
          // Мягкий мазок — как его растеризует сервер: линия уже на половину зоны затухания и размыта
          const fade = (shape.size / 2) * (shape.softness ?? 0);
          f.lineCap = 'round';
          f.lineJoin = 'round';
          f.lineWidth = shape.size - fade;
          f.strokeStyle = color;
          if (fade) f.filter = `blur(${(fade / 5) * s * dpr}px)`;
          f.stroke(path);
          f.filter = 'none';
        } else {
          f.fillStyle = color;
          f.fill(path);
        }
      }
      f.globalCompositeOperation = 'source-over';
      outline();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = maskMode ? 0.4 : 0.32;
      ctx.drawImage(this.fill, 0, 0);
      ctx.globalAlpha = 1;
      ctx.drawImage(this.edge, 0, 0);
    }

    // Набросок для модели — своими цветами поверх выделения; при правке маски его не видно, как и выделения
    const strokes: (SketchStroke | Draft)[] = maskMode ? [] : [...this.sketch];
    if (this.draft?.sketch) strokes.push(this.draft);
    if (strokes.length) {
      const k = this.ink.getContext('2d')!;
      k.setTransform(1, 0, 0, 1, 0, 0);
      k.clearRect(0, 0, this.ink.width, this.ink.height);
      toImage(k);
      k.lineCap = 'round';
      k.lineJoin = 'round';
      for (const stroke of strokes) {
        k.globalCompositeOperation = stroke.erase ? 'destination-out' : 'source-over';
        k.strokeStyle = 'color' in stroke ? stroke.color : stroke.sketch!;
        k.lineWidth = stroke.size;
        k.stroke(linePath(stroke.points));
      }
      k.globalCompositeOperation = 'source-over';
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 0.9;
      ctx.drawImage(this.ink, 0, 0);
      ctx.globalAlpha = 1;
    }

    // Объект под курсором и объект, на который навели в списке, — лёгкой заливкой с контуром
    const glow = (img: CanvasImageSource, r: RectDto, alpha: number) => {
      f.setTransform(1, 0, 0, 1, 0, 0);
      f.globalCompositeOperation = 'source-over';
      f.clearRect(0, 0, this.fill.width, this.fill.height);
      toImage(f);
      f.drawImage(img, r.x, r.y, r.width, r.height);
      f.setTransform(1, 0, 0, 1, 0, 0);
      f.globalCompositeOperation = 'source-in';
      f.fillStyle = ACCENT;
      f.fillRect(0, 0, this.fill.width, this.fill.height);
      f.globalCompositeOperation = 'source-over';
      outline();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = alpha;
      ctx.drawImage(this.fill, 0, 0);
      ctx.globalAlpha = 1;
      ctx.drawImage(this.edge, 0, 0);
    };
    if (this.hover && this.objectTool() && !this.draft) glow(this.hover.bitmap, this.hover.rect, 0.16);
    const lit = this.highlight && !maskMode ? this.maskImage(this.highlight) : null;
    if (lit && this.highlight) glow(lit, this.highlight, 0.2);

    // Области задач с номерами, как в очереди, и границы правимого слоя: за ними маску не расширить
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.draft?.pick && this.draft.points.length > 1) {
      const [a, b] = [this.draft.points[0]!, this.draft.points[this.draft.points.length - 1]!];
      ctx.strokeStyle = this.draft.erase ? ERROR : ACCENT;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(o.x + Math.min(a[0], b[0]) * s, o.y + Math.min(a[1], b[1]) * s, Math.abs(b[0] - a[0]) * s, Math.abs(b[1] - a[1]) * s);
      ctx.setLineDash([]);
    }
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
    if (this.edit?.view.kind === 'layer') frame(this.edit.view.rect, 'Маска слоя', ACCENT, 2, [6, 4]);
    if (this.modelFrame && !maskMode) frame(this.modelFrame, 'Видит модель', MODEL_FRAME, 1, [3, 3]);
    // С «Сдвинуть» видно, что можно сдвинуть
    if (this.activeTool() === 'move' && !maskMode) {
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      for (const { id, hit: r } of this.movable) {
        // Пока сервер не прислал новое место, рамку сдвигаем сами
        const old = moved?.item.id === id && r.x === moved.item.hit.x && r.y === moved.item.hit.y;
        const [dx, dy] = old ? [moved.dx, moved.dy] : [0, 0];
        ctx.strokeRect(Math.round(o.x + (r.x + dx) * s) + 0.5, Math.round(o.y + (r.y + dy) * s) + 0.5, Math.round(r.width * s), Math.round(r.height * s));
      }
      ctx.setLineDash([]);
    }

    // Курсор кисти; у мягкой кисти пунктиром — где кончается сплошная середина; у наброска — его цветом
    const tool = this.activeTool();
    if (this.cursor && (tool === 'brush' || tool === 'eraser' || tool === 'sketch')) {
      const circle = (radius: number, dash: number[]) => {
        ctx.beginPath();
        ctx.arc(this.cursor!.x, this.cursor!.y, radius, 0, Math.PI * 2);
        ctx.setLineDash(dash);
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = 'rgba(0,0,0,0.55)';
        ctx.stroke();
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = tool === 'eraser' ? '#fff' : tool === 'sketch' ? this.sketchColor : ACCENT;
        ctx.stroke();
        ctx.setLineDash([]);
      };
      const radius = (tool === 'sketch' ? this.sketchPx : this.brushPx) / 2;
      circle(radius, []);
      if (tool === 'sketch') return;
      const soft = maskMode ? this.softness : 0;
      if (soft > 0 && radius * (1 - soft) >= 2) circle(radius * (1 - soft), [3, 3]);
    }
  }
}
