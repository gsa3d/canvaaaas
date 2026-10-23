// Типы, общие для сервера и интерфейса: что лежит в /api/state и что шлёт интерфейс.
// Только типы — сюда нельзя импортировать ничего из Node.

export interface RectDto {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Фигура выделения в координатах холста; erase — стирает из маски */
export type MaskShape =
  | { kind: 'rect'; x: number; y: number; width: number; height: number; erase?: boolean }
  | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number; erase?: boolean }
  | { kind: 'polygon'; points: [number, number][]; erase?: boolean }
  | { kind: 'stroke'; points: [number, number][]; size: number; erase?: boolean };

export type ModelChoice = 'flash' | 'pro';
export type SizeChoice = 'auto' | '1K' | '2K' | '4K';

export interface DocDto {
  id: string;
  name: string;
  width: number;
  height: number;
  rev: number;
  levels: number;
  tileSize: number;
  style: string;
  /** Файл на диске; null — новый холст или картинка, загруженная из браузера */
  path: string | null;
  /** Есть несохранённые изменения */
  dirty: boolean;
  /** Почему «Сохранить» не перезапишет файл, а предложит новый */
  saveBlocker?: string;
}

export interface RecentDto {
  id: string;
  name: string;
  path: string;
  width: number;
  height: number;
  openedAt: string;
}

export interface VariantDto {
  n: number;
  status: 'running' | 'done' | 'error';
  error?: string;
  elapsedMs?: number;
  /** Доля пикселей вне маски, которые модель заметно изменила */
  outsideChangedPct?: number;
  /** Доля пикселей внутри маски, которые модель заметно изменила: около нуля — правка не случилась */
  insideChangedPct?: number;
}

export interface JobDto {
  id: string;
  prompt: string;
  model: ModelChoice;
  status: 'queued' | 'preparing' | 'running' | 'done' | 'error';
  error?: string;
  createdAt: string;
  /** Сколько референсов ушло с правкой */
  refs: number;
  bbox?: RectDto;
  /** Часть куска внутри холста: здесь лежат слой правки и маска */
  inside?: RectDto;
  imageSize?: string;
  modelSize?: { width: number; height: number };
  warnings: string[];
  variants: VariantDto[];
  selected: number;
  /** Растёт при любой перевклейке: по нему браузер перезапрашивает слой и маску */
  rev: number;
  canUndoMask: boolean;
}

export interface PatchDto {
  id: string;
  prompt: string;
  rect: RectDto;
  active: boolean;
  createdAt: string;
  /** Меняется при каждой правке маски слоя: по нему браузер перезапрашивает её картинку */
  maskRev: number;
}

export interface StateDto {
  provider: 'laozhang' | 'mock';
  /** Есть ли ключ laozhang.ai (само значение интерфейс никогда не получает) */
  hasKey: boolean;
  doc: DocDto | null;
  jobs: JobDto[];
  history: PatchDto[];
  canUndo: boolean;
  canRedo: boolean;
  generations: { session: number; today: number };
  recent: RecentDto[];
  /** Что сервер сейчас делает с файлом: «Открываю…», «Сохраняю…» */
  activity: string | null;
  /** Есть окна выбора файла (в приложении); без них картинка загружается из браузера */
  nativeFiles: boolean;
}

export interface CreateJobRequest {
  shapes: MaskShape[];
  prompt: string;
  variants: number;
  model: ModelChoice;
  size: SizeChoice;
  /** Картинки-референсы, загруженные через /api/refs (не больше MAX_REFERENCES) */
  refs?: string[];
}

export const MAX_REFERENCES = 3;

/** Заголовок, без которого сервер не примет изменяющий запрос (защита от чужих страниц) */
export const API_HEADER = 'x-canvaaaas';

/** Прямоугольник, в который помещаются все добавляющие фигуры (ластик не расширяет выделение) */
export function shapesBBox(shapes: MaskShape[]): RectDto | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const add = (x: number, y: number, pad = 0) => {
    x0 = Math.min(x0, x - pad);
    y0 = Math.min(y0, y - pad);
    x1 = Math.max(x1, x + pad);
    y1 = Math.max(y1, y + pad);
  };
  for (const s of shapes) {
    if (s.erase) continue;
    if (s.kind === 'rect') {
      add(s.x, s.y);
      add(s.x + s.width, s.y + s.height);
    } else if (s.kind === 'ellipse') {
      add(s.cx - s.rx, s.cy - s.ry);
      add(s.cx + s.rx, s.cy + s.ry);
    } else {
      const pad = s.kind === 'stroke' ? s.size / 2 : 0;
      for (const [x, y] of s.points) add(x, y, pad);
    }
  }
  if (x1 < x0) return null;
  return { x: Math.floor(x0), y: Math.floor(y0), width: Math.ceil(x1 - x0), height: Math.ceil(y1 - y0) };
}

/** Команды из меню приложения: Electron шлёт их в окно событием COMMAND_EVENT */
export type AppCommand =
  | 'settings'
  | 'open'
  | `open-recent:${string}`
  | 'new'
  | 'save'
  | 'save-as'
  | 'undo'
  | 'redo'
  | 'zoom-fit'
  | 'zoom-100'
  | 'zoom-50'
  | 'zoom-in'
  | 'zoom-out';

export const COMMAND_EVENT = 'canvaaaas-command';

/** Пресеты нового холста; dpi записывается в файл, чтобы печать шла в нужном размере */
export const CANVAS_PRESETS: { name: string; width: number; height: number; dpi?: number }[] = [
  { name: 'Full HD', width: 1920, height: 1080 },
  { name: '4K', width: 3840, height: 2160 },
  { name: '8K', width: 7680, height: 4320 },
  { name: 'Квадрат', width: 4096, height: 4096 },
  { name: 'Большой 4:3', width: 8000, height: 6000 },
  { name: 'A4', width: 2480, height: 3508, dpi: 300 },
  { name: 'A3', width: 3508, height: 4961, dpi: 300 },
  { name: 'A2', width: 4961, height: 7016, dpi: 300 },
];
