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
  /** softness — доля радиуса кисти, на которой мазок плавно сходит на нет: 0 — жёсткий край, 1 — затухает от середины */
  | { kind: 'stroke'; points: [number, number][]; size: number; softness?: number; erase?: boolean }
  /**
   * Маска с сервера: объект под щелчком (id из /api/segment) или сохранённый объект (obj:id).
   * x…height — где она лежит; rev меняется вместе с маской объекта
   */
  | { kind: 'mask'; id: string; x: number; y: number; width: number; height: number; rev?: number; erase?: boolean };

/** Штрих наброска для модели в координатах холста: где и каким должно быть то, что описано в задаче; erase — стирает набросок */
export interface SketchStroke {
  points: [number, number][];
  /** Толщина, пиксели холста */
  size: number;
  /** #rrggbb */
  color: string;
  erase?: boolean;
}

/** flash и pro — Nano Banana через laozhang.ai по ключу; chatgpt — ChatGPT Images по подписке через Codex CLI */
export type ModelChoice = 'flash' | 'pro' | 'chatgpt';
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
  /** Файл — проект .caaa: слои сохраняются слоями */
  project: boolean;
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
  /** Не новая генерация, а слой, который сейчас лежит на холсте */
  current?: boolean;
  /** С какой задачей и показом области сделан вариант: после повтора с поправкой они у вариантов разные */
  prompt: string;
  hide: boolean;
  /** Задача, как её расписал директор для этого варианта */
  directed?: string;
  /** Шаг с критиком: вариант исправляет вариант base по этим замечаниям */
  fixes?: string;
  base?: number;
  /** Что критик сказал о варианте: done — готово, text — почему или что исправить, по строке на замечание */
  critique?: { done: boolean; text: string };
}

export interface JobDto {
  id: string;
  /** Задача, с которой пойдут следующие варианты */
  prompt: string;
  /** Модель не видит, что под маской: область ей стирают */
  hide: boolean;
  model: ModelChoice;
  status: 'queued' | 'preparing' | 'running' | 'done' | 'error';
  error?: string;
  createdAt: string;
  /** Сколько референсов ушло с правкой */
  refs: number;
  /** С правкой ушёл набросок */
  sketch: boolean;
  /** Перед генерацией задачу расписывает директор */
  director: boolean;
  /** Директор сейчас расписывает задачу */
  directing: boolean;
  /** Критик сейчас смотрит вариант */
  reviewing: boolean;
  /** Идут шаги с критиком: какой сейчас генерируется (0 — ещё ни один) и сколько их самое большее */
  chain?: { step: number; steps: number };
  /** Задача, как её расписал директор, — для следующих вариантов */
  directed?: string;
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
  /** Растёт только при правке маски: по нему браузер узнаёт, что маску поменяли не его мазки */
  maskRev: number;
  /** Растушёвка внутрь маски, пиксели холста */
  feather?: number;
  canUndoMask: boolean;
  /** Ещё варианты принятого слоя: «Принять» заменит этот слой */
  replaces?: string;
}

export interface PatchDto {
  id: string;
  prompt: string;
  rect: RectDto;
  active: boolean;
  createdAt: string;
  /** Меняется при каждой правке маски слоя: по нему браузер перезапрашивает её картинку */
  maskRev: number;
  /** Модель, которой сделан слой: ею же идут «Ещё варианты» */
  model?: ModelChoice;
  /** Растушёвка внутрь маски, пиксели холста */
  feather: number;
  /** Модель не видела, что было под маской */
  hide?: boolean;
  /** Задача, как её расписал директор */
  directed?: string;
  /** С правкой ушёл набросок */
  sketch?: boolean;
  /** Правили этот объект: его маска была выделением */
  object?: string;
}

export interface ObjectDto {
  id: string;
  name: string;
  rect: RectDto;
  /** Объект, частью которого этот является */
  parent?: string;
  /** Растёт, когда маска меняется: по нему браузер перезапрашивает её картинку */
  rev: number;
  /** После правки на холсте объект не нашёлся */
  lost?: boolean;
}

/** Модель выделения объектов: её веса скачиваются по просьбе пользователя */
export interface SegmentDto {
  status: 'missing' | 'downloading' | 'loading' | 'ready' | 'error';
  /** Доля скачанного, 0..1 */
  progress?: number;
  error?: string;
  /** Где считает кодировщик */
  backend?: 'webgpu' | 'cpu';
  /** Пересчитываются маски объектов после правки */
  following: boolean;
}

/** Точка подсказки для выделения объекта: positive — объект здесь, иначе — здесь не он */
export interface SegmentPoint {
  x: number;
  y: number;
  positive: boolean;
}

/** Выделить объект: точки и (или) рамка в координатах холста, view — видимая часть холста */
export interface PickRequest {
  view: RectDto;
  points: SegmentPoint[];
  box?: RectDto;
}

/** Уровни объекта от мелкого к крупному («деталь / часть / целое»); level — какой показать первым */
export interface PickResult {
  levels: { id: string; rect: RectDto }[];
  level: number;
}

/** Какие ответы умеет модель — чтобы подсказать про разрешение ещё до генерации */
export interface ModelOutputsDto {
  /** Разрешения от меньшего к большему */
  imageSizes: string[];
  /** Размер ответа: outputs[пропорции][разрешение] */
  outputs: Record<string, Record<string, { width: number; height: number }>>;
}

export interface StateDto {
  provider: 'laozhang' | 'mock';
  models: Record<ModelChoice, ModelOutputsDto>;
  /** Есть ли ключ laozhang.ai (само значение интерфейс никогда не получает) */
  hasKey: boolean;
  /** Codex CLI, через который идёт ChatGPT по подписке: путь или null, если не найден */
  codex: string | null;
  doc: DocDto | null;
  jobs: JobDto[];
  history: PatchDto[];
  objects: ObjectDto[];
  segment: SegmentDto;
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
  /** Сколько вариантов; с директором — сколько шагов с критиком самое большее */
  variants: number;
  model: ModelChoice;
  size: SizeChoice;
  /** Картинки-референсы, загруженные через /api/refs (не больше MAX_REFERENCES) */
  refs?: string[];
  /** Стереть модели то, что под маской: пусть рисует область заново, а не правит увиденное */
  hide?: boolean;
  /** Набросок поверх куска: где и каким должно быть то, что в задаче */
  sketch?: SketchStroke[];
  /**
   * Перед генерацией ChatGPT расписывает задачу подробнее; задача пользователя остаётся как есть.
   * Варианты тогда идут шагами: критик смотрит каждый и говорит, что исправить в следующем
   */
  director?: boolean;
}

/** Повтор правки с поправкой: другая задача, показ области или директор; чего нет — остаётся как было */
export interface RedoChange {
  prompt?: string;
  hide?: boolean;
  director?: boolean;
}

/** «Ещё варианты» принятого слоя: задача, маска и референсы — слоя, модель и разрешение — слоя, если он их помнит */
export interface PatchVariantsRequest extends RedoChange {
  variants: number;
  model: ModelChoice;
  size: SizeChoice;
}

/** «Ещё варианты» задачи в очереди, можно с поправкой; с директором — ещё шаги от выбранного варианта */
export interface MoreVariantsRequest extends RedoChange {
  count: number;
}

/** Ответ на мазок по маске: номер её нового состояния и rev того, что теперь надо перерисовать (холста или задачи) */
export interface MaskEditResult {
  version: number;
  rev: number;
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
    } else if (s.kind === 'mask') {
      add(s.x, s.y);
      add(s.x + s.width, s.y + s.height);
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
  | 'export'
  | 'undo'
  | 'redo'
  | 'deselect'
  | 'save-object'
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
