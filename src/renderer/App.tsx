import {
  IconArrowBackUp,
  IconArrowForwardUp,
  IconArrowsExchange,
  IconArrowsMove,
  IconBrush,
  IconCubePlus,
  IconDots,
  IconEraser,
  IconEye,
  IconEyeOff,
  IconHandStop,
  IconHelpCircle,
  IconLasso,
  IconLayersSubtract,
  IconLayersUnion,
  IconMarquee2,
  IconMarqueeOff,
  IconMask,
  IconMinus,
  IconPencil,
  IconPhoto,
  IconPhotoPlus,
  IconScissors,
  IconPlus,
  IconScribble,
  IconSquare,
  IconStack2,
  IconStackPlus,
  IconLoader2,
  IconAlertTriangle,
  IconCheck,
  IconArrowBarToDown,
  IconTrash,
  IconWand,
  IconX,
  type Icon,
} from '@tabler/icons-preact';
import { Fragment, type ComponentChildren } from 'preact';
import { createPortal } from 'preact/compat';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { adviseSize, intersect, type ModelOutputs, type SizeAdvice } from '../core/frame.ts';
import { layerName } from '../core/objects.ts';
import {
  CANVAS_PRESETS,
  COMMAND_EVENT,
  MAX_REFERENCES,
  OUTSIDE_LAYER,
  shapesBBox,
  type AppCommand,
  type DocDto,
  type JobDto,
  type MaskEditResult,
  type MaskResult,
  type MaskShape,
  type ModelChoice,
  type ModelOutputsDto,
  type ObjectDto,
  type PatchDto,
  type PickResult,
  type RecentDto,
  type RedoChange,
  type SegmentPoint,
  type SizeChoice,
  type SketchStroke,
  type StateDto,
} from '../shared/api.ts';
import { getState, post, subscribe, upload, uploadReference } from './api.ts';
import { CanvasView, type MaskEditView, type MaskRef, type Movable, type PickEvent, type SelectOp, type Tool } from './viewer.ts';

/** Объект, выделенный «Палочкой»: его уровни и подсказки, по которым он найден */
interface Pick {
  levels: (MaskResult & { refined?: boolean })[];
  level: number;
  points: SegmentPoint[];
  box?: { x: number; y: number; width: number; height: number };
  erase: boolean;
  /** Край привязан к линиям рисунка — уточнённая маска тоже */
  snap: boolean;
  /** Куда щёлкнули: щелчок туда же — следующий уровень */
  at?: [number, number];
}

/** Настройка, которая помнится между запусками; без доступа к памяти браузера — просто по умолчанию */
function usePref<T>(key: string, initial: T): [T, (value: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const saved = localStorage.getItem(`canvaaaas:${key}`);
      return saved === null ? initial : (JSON.parse(saved) as T);
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(`canvaaaas:${key}`, JSON.stringify(value));
    } catch {
      // Не запомнилось — в следующий раз будет по умолчанию
    }
  }, [value]);
  return [value, setValue];
}

/** Подписи уровней объекта от мелкого к крупному */
function levelNames(n: number): string[] {
  return n >= 3 ? ['Деталь', 'Часть', 'Целое'].concat(Array.from({ length: n - 3 }, (_, i) => `${i + 4}`)) : ['Часть', 'Целое'].slice(2 - n);
}

/** Сохранённый объект как фигура выделения */
function objectShape(o: ObjectDto): MaskRef {
  return { kind: 'mask', id: `obj:${o.id}`, ...o.rect, rev: o.rev };
}

function plural(n: number, one: string, few: string, many: string): string {
  const d = n % 10;
  const dd = n % 100;
  if (d === 1 && dd !== 11) return one;
  if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return few;
  return many;
}

/** Сколько сгенерировать: варианты разом или, с директором, шаги с критиком */
function countText(director: boolean, n: number): string {
  return `${n} ${director ? plural(n, 'шаг', 'шага', 'шагов') : plural(n, 'вариант', 'варианта', 'вариантов')}`;
}

/** Надпись кнопки генерации */
function generateText(director: boolean, n: number): string {
  return director ? `Сгенерировать в ${countText(true, n)}` : `Сгенерировать ${countText(false, n)}`;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** Две последние папки пути: «work/step1»; полный путь — во всплывающей подсказке */
function folder(path: string): string {
  const parts = path.split(/[\\/]/).slice(0, -1).filter(Boolean);
  return (parts.length > 2 ? '…/' : '') + parts.slice(-2).join('/');
}

function short(text: string, max = 32): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Короткий отпечаток строки — для адреса картинки, которая меняется вместе с ней */
function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Что браузеру нужно для живого превью правки маски слоя */
function layerMaskEdit(layer: PatchDto, layers: PatchDto[]): MaskEditView {
  // Холст под слоем и над ним меняется, только когда меняются другие слои
  const context = hash(layers.map((p) => (p.id === layer.id ? '*' : `${p.id}:${p.maskRev}:${p.active ? 1 : 0}`)).join(','));
  const base = `/api/history/${layer.id}/edit`;
  return {
    kind: 'layer',
    target: layer.id,
    rect: layer.rect,
    feather: layer.feather,
    below: `${base}/below.jpg?c=${context}`,
    above: `${base}/above.png?c=${context}`,
    layer: `${base}/layer.jpg`,
    mask: `${base}/mask.png`,
  };
}

function modelOutputs(dto: ModelOutputsDto): ModelOutputs {
  return {
    aspectRatios: Object.keys(dto.outputs),
    imageSizes: dto.imageSizes,
    outputSize: (aspectRatio, imageSize) => {
      const out = dto.outputs[aspectRatio]?.[imageSize];
      if (!out) throw new Error(`Модель не умеет ${aspectRatio} в ${imageSize}`);
      return out;
    },
  };
}

/** Хватает ли выделению выбранного разрешения — тем же расчётом, что сделает сервер; ошибка — текстом */
function adviseSelection(doc: DocDto, shapes: MaskShape[], dto: ModelOutputsDto, size: SizeChoice): SizeAdvice | string | null {
  const box = shapesBBox(shapes);
  const area = box && intersect(box, { x: 0, y: 0, width: doc.width, height: doc.height });
  if (!area?.width || !area.height) return null;
  try {
    return adviseSize(area, doc, modelOutputs(dto), size);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

// Иконки — Tabler (tabler.io/icons), обводка чуть тоньше стандартной
const STROKE = 1.75;

const TOOL_ICONS: Record<Tool, Icon> = {
  object: IconWand,
  move: IconArrowsMove,
  hand: IconHandStop,
  rect: IconMarquee2,
  lasso: IconLasso,
  brush: IconBrush,
  eraser: IconEraser,
  sketch: IconScribble,
};

/** name — на панели настроек, label — во всплывающей подсказке */
const TOOLS: { id: Tool; name: string; label: string; key: string }[] = [
  { id: 'object', name: 'Палочка', label: 'Палочка: объект под щелчком', key: 'W' },
  { id: 'move', name: 'Сдвинуть', label: 'Сдвинуть слой', key: 'V' },
  { id: 'rect', name: 'Прямоугольник', label: 'Прямоугольник', key: 'R' },
  { id: 'lasso', name: 'Лассо', label: 'Лассо', key: 'L' },
  { id: 'brush', name: 'Кисть', label: 'Кисть', key: 'B' },
  { id: 'eraser', name: 'Ластик', label: 'Ластик', key: 'E' },
  { id: 'sketch', name: 'Набросок', label: 'Набросок для модели, Alt стирает', key: 'S' },
  { id: 'hand', name: 'Рука', label: 'Рука (или зажать пробел)', key: 'H' },
];

/** Инструменты выделения: у них режим «Новое / Добавить / Вычесть» и край */
const SELECTING: Tool[] = ['object', 'rect', 'lasso', 'brush', 'eraser'];

/** Цвета наброска под рукой; любой другой — из палитры */
const SKETCH_COLORS = ['#ff3b30', '#1e88ff', '#22b14c', '#111111', '#ffffff'];

const MODELS: { id: ModelChoice; label: string; tag: string }[] = [
  { id: 'flash', label: 'Nano Banana 2', tag: '' },
  { id: 'pro', label: 'Nano Banana Pro', tag: 'Pro' },
  { id: 'chatgpt', label: 'ChatGPT Images, подписка', tag: 'ChatGPT' },
];

/** Nano Banana идёт через laozhang.ai по ключу, ChatGPT — по подписке через Codex, ключ ему не нужен */
const needsKey = (model: ModelChoice) => model !== 'chatgpt';

/** Что сейчас с задачей: директор расписывает её до генерации */
function jobStatus(job: JobDto): string {
  if (job.directing) return 'Директор думает';
  if (job.reviewing) return 'Критик смотрит';
  if (job.chain?.step) return `Шаг ${job.chain.step} из ${job.chain.steps}`;
  return STATUS[job.status];
}

const STATUS: Record<JobDto['status'], string> = {
  queued: 'Ждёт очереди',
  preparing: 'Готовлю кусок',
  running: 'Генерация',
  done: 'Готово',
  error: 'Ошибка',
};

export function App() {
  const [state, setState] = useState<StateDto | null>(null);
  const [tool, setTool] = useState<Tool>('rect');
  const [brush, setBrush] = usePref('brush', 40);
  /** Мягкость края кисти при правке маски, 0..1 */
  const [softness, setSoftness] = usePref('softness', 0.5);
  /** Режим выделения: заменить, добавить, вычесть; Shift и Alt — на время щелчка */
  const [selectMode, setSelectMode] = usePref<SelectOp>('select-mode', 'new');
  /** Край объекта и мазка кисти — по линиям рисунка */
  const [objectSnap, setObjectSnap] = usePref('object-snap', true);
  const [brushSnap, setBrushSnap] = usePref('brush-snap', false);
  /** Край выделения шире или уже: от какого выделения считали (base) и что вышло (result) */
  const [edge, setEdge] = useState<{ base: MaskShape[]; px: number; result?: MaskShape } | null>(null);
  const [selection, setSelection] = useState<MaskShape[]>([]);
  /** Набросок для модели к новой правке */
  const [sketch, setSketch] = useState<SketchStroke[]>([]);
  const [sketchSize, setSketchSize] = usePref('sketch-size', 10);
  const [sketchColor, setSketchColor] = usePref('sketch-color', SKETCH_COLORS[0]!);
  const [prompt, setPrompt] = useState('');
  /** Стереть модели то, что под выделением */
  const [hide, setHide] = useState(false);
  /** Перед генерацией ChatGPT расписывает задачу */
  const [director, setDirector] = useState(false);
  const [model, setModel] = useState<ModelChoice>('flash');
  const [size, setSize] = useState<SizeChoice>('auto');
  const [variants, setVariants] = useState(2);
  /** Сколько шагов с критиком, когда включён директор */
  const [steps, setSteps] = useState(3);
  /** Слой, маску которого сейчас правят */
  const [maskLayer, setMaskLayer] = useState<string | null>(null);
  /** Слой, в котором работают: палочка ищет только в нём, генерация ложится его версией; нет — новым слоем */
  const [active, setActive] = useState<string | null>(null);
  const [zoom, setZoom] = useState(0);
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [styleDraft, setStyleDraft] = useState('');
  const [dialog, setDialog] = useState<'settings' | 'new' | null>(null);
  const [zoomMenu, setZoomMenu] = useState(false);
  const [refs, setRefs] = useState<string[]>([]);
  /** Объект, на который навели в списке объектов */
  const [litObject, setLitObject] = useState<string | null>(null);
  /** Держат «\»: на холсте исходник */
  const [comparing, setComparing] = useState(false);
  const [, setTick] = useState(0);

  const stageRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const refRef = useRef<HTMLInputElement>(null);
  const viewRef = useRef<CanvasView | null>(null);
  const refreshSeq = useRef(0);
  const onShape = useRef<(shape: MaskShape, op: SelectOp) => void>(() => undefined);
  const onSketch = useRef<(stroke: SketchStroke) => void>(() => undefined);
  const onPick = useRef<(event: PickEvent) => void>(() => undefined);
  const onMove = useRef<(id: string, dx: number, dy: number) => Promise<number>>(() => Promise.reject(new Error('Нет документа')));
  /** Как найдена каждая фигура «Палочки» в выделении */
  const picks = useRef(new WeakMap<MaskShape, Pick>());
  /** Выделение на этот миг: щелчки «Палочкой» идут по очереди и не ждут перерисовки */
  const selectionRef = useRef<MaskShape[]>([]);
  const pickChain = useRef<Promise<unknown>>(Promise.resolve());
  /** В каком порядке в форму новой правки ложились фигуры выделения и штрихи наброска — ⌘Z убирает последнее */
  const formOrder = useRef<('shape' | 'sketch')[]>([]);
  const onMaskShape = useRef<(view: MaskEditView, shape: MaskShape) => Promise<MaskEditResult>>(() => Promise.reject(new Error('Нет правки маски')));
  const styleTimer = useRef<number | undefined>(undefined);
  const toastTimer = useRef<number | undefined>(undefined);

  const doc = state?.doc ?? null;
  const jobs = state?.jobs ?? [];
  const layers = state?.history ?? [];
  const objects = state?.objects ?? [];
  const segment = state?.segment;
  const segmentReady = segment?.status === 'ready';
  selectionRef.current = selection;
  const editedLayer = layers.find((p) => p.id === maskLayer && p.active) ?? null;
  const maskEdit = editedLayer ? layerMaskEdit(editedLayer, layers) : null;
  const activeObj = active ? objects.find((o) => o.id === active) : undefined;

  const notify = (text: string, error = true) => {
    setToast({ text, error });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), error ? 8000 : 4000);
  };
  const fail = (err: unknown) => notify(err instanceof Error ? err.message : String(err));

  const refresh = () => {
    const seq = ++refreshSeq.current;
    getState()
      .then((s) => {
        if (seq === refreshSeq.current) setState(s);
      })
      .catch(fail);
  };

  useEffect(() => {
    viewRef.current = new CanvasView(stageRef.current!, {
      onShape: (shape, op) => onShape.current(shape, op),
      onSketch: (stroke) => onSketch.current(stroke),
      onMaskShape: (view, shape) => onMaskShape.current(view, shape),
      onPick: (event) => onPick.current(event),
      onMove: (id, dx, dy) => onMove.current(id, dx, dy),
      onZoom: setZoom,
    });
    refresh();
    return subscribe(refresh);
  }, []);

  useEffect(() => viewRef.current?.setDocument(doc), [doc?.id, doc?.rev]);
  useEffect(() => {
    document.title = doc ? `${doc.name}${doc.dirty ? ' •' : ''} — canvaaaas` : 'canvaaaas';
  }, [doc?.name, doc?.dirty]);
  useEffect(() => {
    setStyleDraft(doc?.style ?? '');
    setSelection([]);
    setSketch([]);
    formOrder.current = [];
    setMaskLayer(null);
    setActive(null);
  }, [doc?.id]);
  // Удалённый слой — работа вне слоя
  useEffect(() => {
    if (active && state && !activeObj) setActive(null);
  }, [active, !!activeObj]);
  useEffect(() => viewRef.current?.setLayer(activeObj && !maskLayer ? objectShape(activeObj) : null), [activeObj?.id, activeObj?.rev, !!maskLayer]);
  // Слой, в который вошли щелчком на холсте, виден и в списке
  useEffect(() => {
    if (active) document.querySelector(`.layers li[data-layer="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  // На холсте — рамки идущих генераций и генераций с ошибкой, с подписью слоя
  useEffect(() => {
    const open = jobs.filter((j) => busyJob(j) || j.status === 'error');
    const labels = new Map(
      open.map((j) => {
        const o = objects.find((x) => x.id === (j.detach ?? j.object));
        return [j.id, o ? (j.detach ? `Фон под «${short(o.name, 20)}»` : short(o.name, 24)) : 'Новый слой'];
      }),
    );
    viewRef.current?.setJobs(open, labels);
  }, [state?.jobs, state?.objects]);
  // Законченная генерация больше не нужна: её варианты — версии слоёв. Задачи с ошибкой остаются, пока их не уберут
  const discarded = useRef(new Set<string>());
  useEffect(() => {
    for (const j of jobs) {
      if (j.status !== 'done' || busyJob(j) || discarded.current.has(j.id)) continue;
      discarded.current.add(j.id);
      post(`/api/jobs/${j.id}/discard`).catch(() => discarded.current.delete(j.id));
    }
  }, [state?.jobs]);
  // Скрытая или удалённая версия маску больше не правит
  useEffect(() => {
    if (maskLayer && !editedLayer) setMaskLayer(null);
  }, [maskLayer, editedLayer?.id]);
  const maskEditKey = JSON.stringify(maskEdit);
  useEffect(() => viewRef.current?.setMaskEdit(maskEdit), [maskEditKey]);
  useEffect(() => viewRef.current?.setSelection(selection), [selection]);
  useEffect(() => viewRef.current?.setSketch(sketch), [sketch]);
  useEffect(() => viewRef.current?.setSketchBrush(sketchSize, sketchColor), [sketchSize, sketchColor]);
  useEffect(() => viewRef.current?.setTool(tool), [tool]);
  useEffect(() => viewRef.current?.setSelectMode(selectMode), [selectMode]);
  useEffect(() => viewRef.current?.setSegmentReady(segmentReady), [segmentReady]);
  // Маски объектов в выделении следуют за объектами: после правки маска другая, удалённый объект уходит из выделения
  const objectsKey = objects.map((o) => `${o.id}:${o.rev}`).join(',');
  useEffect(() => {
    const byId = new Map(objects.map((o) => [`obj:${o.id}`, o]));
    setSelection((sel) => {
      if (!sel.some((s) => s.kind === 'mask' && s.id.startsWith('obj:'))) return sel;
      const next = sel.flatMap((s): MaskShape[] => {
        if (s.kind !== 'mask' || !s.id.startsWith('obj:')) return [s];
        const o = byId.get(s.id);
        return o ? [o.rev === s.rev ? s : { ...objectShape(o), erase: s.erase }] : [];
      });
      return next.length === sel.length && next.every((s, i) => s === sel[i]) ? sel : next;
    });
  }, [objectsKey]);
  // Видимые слои с дорисованным фоном — их можно сдвинуть; превью — их версия на холсте (или снятый исходник)
  const movable: Movable[] = objects.flatMap((o) => {
    const shown = o.kind !== 'fill' && !o.hidden ? layers.find((p) => p.id === (o.current ?? o.layer)) : undefined;
    return shown ? [{ id: o.id, layer: shown.id, rect: shown.rect, hit: o.rect }] : [];
  });
  const movableKey = JSON.stringify(movable);
  useEffect(() => viewRef.current?.setMovable(movable), [movableKey]);
  const lit = objects.find((o) => o.id === litObject);
  useEffect(() => viewRef.current?.setHighlight(lit ? objectShape(lit) : null), [lit?.id, lit?.rev]);
  useEffect(() => viewRef.current?.setBrush(brush, softness), [brush, softness]);

  const anyRunning = jobs.some((j) => j.status !== 'done' && j.status !== 'error');
  useEffect(() => {
    if (!anyRunning) return;
    const t = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [anyRunning]);

  onShape.current = (shape, op) => {
    if (op === 'new') formOrder.current = formOrder.current.filter((k) => k !== 'shape');
    formOrder.current.push('shape');
    updateSelection((s) => (op === 'new' ? [shape] : [...s, shape]));
    // Кисть по линиям: мазок заменяется маской, привязанной к рисунку, когда сервер её посчитает
    if (brushSnap && shape.kind === 'stroke' && (tool === 'brush' || tool === 'eraser')) {
      const { erase, ...stroke } = shape;
      // Запас — треть радиуса кисти: клетка, которую мазок почти накрыл, берётся вся, а соседняя большая — нет
      post<MaskResult>('/api/selection/snap', { shapes: [stroke], reach: shape.size / 6 })
        .then(async (r) => {
          const snapped: MaskRef = { kind: 'mask', id: r.id, ...r.rect, erase };
          await viewRef.current?.loadMask(snapped);
          updateSelection((sel) => sel.map((s) => (s === shape ? snapped : s)));
        })
        .catch(fail);
    }
  };
  onSketch.current = (stroke) => {
    formOrder.current.push('sketch');
    setSketch((s) => [...s, stroke]);
  };
  const clearSelection = () => {
    formOrder.current = formOrder.current.filter((k) => k !== 'shape');
    setSelection([]);
  };

  // ——— «Палочка»: объект под щелчком ———

  /** Выделение сейчас: менять его из щелчков «Палочкой» — только так, чтобы следующий щелчок видел его сразу */
  const updateSelection = (fn: (sel: MaskShape[]) => MaskShape[]) => {
    selectionRef.current = fn(selectionRef.current);
    setSelection(selectionRef.current);
  };
  /** Объект, найденный последним: последняя фигура выделения, если её дала «Палочка» */
  const lastPick = (): { shape: MaskShape; pick: Pick } | null => {
    const shape = selectionRef.current.at(-1);
    const pick = shape && picks.current.get(shape);
    return shape && pick ? { shape, pick } : null;
  };
  /**
   * Показать уровень объекта, когда его маска загрузилась: на месте прежней фигуры этого объекта (replace),
   * вместо всего выделения ('all') или ещё одной фигурой ('add')
   */
  const showPick = async (pick: Pick, replace: MaskShape | 'all' | 'add') => {
    const lv = pick.levels[pick.level]!;
    const shape: MaskRef = { kind: 'mask', id: lv.id, ...lv.rect, erase: pick.erase || undefined };
    picks.current.set(shape, pick);
    await viewRef.current?.loadMask(shape);
    if (replace === 'all') {
      formOrder.current = formOrder.current.filter((k) => k !== 'shape');
      formOrder.current.push('shape');
      updateSelection(() => [shape]);
    } else if (replace === 'add') {
      formOrder.current.push('shape');
      updateSelection((sel) => [...sel, shape]);
    } else {
      updateSelection((sel) => (sel.includes(replace) ? sel.map((s) => (s === replace ? shape : s)) : [...sel, shape]));
    }
    refineLevel(pick, pick.level, shape);
  };
  /** Мелкий объект сервер уточняет вторым проходом — около секунды; уточнённая маска встаёт на место грубой */
  const refineLevel = (pick: Pick, level: number, shape: MaskShape) => {
    const lv = pick.levels[level]!;
    if (lv.refined) return;
    lv.refined = true;
    post<MaskResult>('/api/segment/refine', { id: lv.id, snap: pick.snap })
      .then((r) => {
        if (r.id === lv.id) return;
        pick.levels[level] = { ...r, refined: true };
        if (selectionRef.current.includes(shape) && pick.level === level) return showPick(pick, shape);
      })
      .catch(() => undefined);
  };
  const queuePick = (fn: () => Promise<void>) => {
    pickChain.current = pickChain.current.then(fn).catch(fail);
  };
  onPick.current = (e) => {
    if (!segmentReady) return;
    queuePick(async () => {
      const last = lastPick();
      const p = e.point;
      // Щелчок туда же с тем же действием — следующий, более крупный уровень того же объекта
      const same = p && last?.pick.at && last.pick.erase === (e.op === 'sub') && Math.hypot(p[0] - last.pick.at[0], p[1] - last.pick.at[1]) < 8 * e.imagePx;
      if (same && last) {
        if (last.pick.levels.length > 1) await showPick({ ...last.pick, level: (last.pick.level + 1) % last.pick.levels.length }, last.shape);
        return;
      }
      // Новый объект: вместо выделения, к нему (Shift) или вычесть из него (Alt). Сервер знает выделение и первым даёт уровень,
      // который его меняет, — щелчок рядом с выделенным не возвращает то, что уже выделено
      const points = p ? [{ x: p[0], y: p[1], positive: true }] : [];
      const selection = e.op === 'new' ? undefined : selectionRef.current;
      const within = activeObj && !maskLayer ? activeObj : undefined;
      const res = await post<PickResult>('/api/segment/pick', { view: e.view, points, box: e.box, snap: objectSnap, op: e.op, selection, within: within?.id }).catch(
        (err: unknown) => {
          // Добавить или вычесть можно только там же, где работают: объекты разных слоёв не смешиваются
          if (err instanceof Error && err.message === OUTSIDE_LAYER) notify(within ? `Вне слоя «${short(within.name, 24)}»` : 'Здесь слой: щелчок без Shift откроет его', false);
          else throw err;
        },
      );
      if (!res) return;
      // Щелчок по другому слою — работа в нём
      if (res.enter) {
        const o = objects.find((x) => x.id === res.owner);
        if (o) enterLayer(o);
        return;
      }
      // Объект нашёлся на фоне — работа вне слоя
      if (e.op === 'new' && res.owner !== (within?.id ?? null)) setActive(res.owner);
      // Уровень, который ничего не меняет, всё равно ложится в выделение: [ и ] переключат его на другой
      if (res.unchanged) notify(`${e.op === 'add' ? 'Это уже в выделении' : 'Этого нет в выделении'}: [ и ] — мельче или крупнее`, false);
      await showPick({ ...res, points, box: e.box, erase: e.op === 'sub', snap: objectSnap, at: p }, e.op === 'new' ? 'all' : 'add');
    });
  };
  /** [ и ] с «Палочкой» — уровень последнего найденного объекта мельче или крупнее */
  const stepLevel = (dir: number) => {
    const last = lastPick();
    if (!last) return;
    const level = Math.min(last.pick.levels.length - 1, Math.max(0, last.pick.level + dir));
    if (level !== last.pick.level) queuePick(() => showPick({ ...last.pick, level }, last.shape));
  };
  const currentPick = selection.length ? picks.current.get(selection.at(-1)!) : undefined;

  // ——— Край выделения ———

  // Край считается от выделения, каким оно было до первого сдвига края: так −2 после +4 — это +2, а не +4 и −2.
  // Сдвиг идёт, пока выделение — то, что из него вышло (или то, от чего считают, пока ответа нет)
  const edgeTimer = useRef<number | undefined>(undefined);
  const edgeActive = !!edge && (edge.result ? selection.length === 1 && selection[0] === edge.result : selection === edge.base);
  const edgePx = edgeActive ? edge!.px : 0;
  const changeEdge = (px: number) => {
    const base = edgeActive ? edge!.base : selection;
    const value = Math.max(-100, Math.min(100, Math.round(px) || 0));
    window.clearTimeout(edgeTimer.current);
    if (!value) {
      setEdge(null);
      if (base !== selection) updateSelection(() => base);
      return;
    }
    const kept = edgeActive ? edge!.result : undefined;
    setEdge({ base, px: value, result: kept });
    edgeTimer.current = window.setTimeout(() => {
      post<MaskResult>('/api/selection/edge', { shapes: base, px: value })
        .then(async (r) => {
          const shape: MaskRef = { kind: 'mask', id: r.id, ...r.rect };
          await viewRef.current?.loadMask(shape);
          // Пока считали, выделение сменили — его не трогаем
          const now = selectionRef.current;
          if (now !== base && !(kept && now.length === 1 && now[0] === kept)) return;
          formOrder.current = [...formOrder.current.filter((k) => k !== 'shape'), 'shape'];
          updateSelection(() => [shape]);
          setEdge({ base, px: value, result: shape });
        })
        .catch(fail);
    }, 250);
  };

  // ——— Объекты ———

  /** ⌘J: то, что видно в выделении, — копией новым слоем сверху; работа сразу в нём */
  const saveObject = async (): Promise<ObjectDto | undefined> => {
    if (!doc || !selection.some((s) => !s.erase)) return;
    try {
      const { id } = await post<{ id: string }>('/api/objects', { shapes: selection });
      // Состояние — с новым слоем: запрошенное раньше и пришедшее позже его не перебьёт
      const seq = ++refreshSeq.current;
      const s = await getState();
      if (seq === refreshSeq.current) setState(s);
      const o = s.objects.find((x) => x.id === id);
      if (o) {
        formOrder.current = formOrder.current.filter((k) => k !== 'shape');
        formOrder.current.push('shape');
        setSelection([objectShape(o)]);
        setActive(o.id);
        notify(`Слой «${o.name}»`, false);
      }
      return o;
    } catch (err) {
      fail(err);
    }
  };
  /** ⌘⇧J: то же, а под новым слоем модель дорисует фон — его можно сдвигать и скрывать */
  const cutObject = async () => {
    const o = await saveObject();
    if (o) await detach(o);
  };
  /** ⌘E: слои в выделении (Shift-щелчком в списке) и тот, в котором работают, — одним слоем; работа сразу в нём */
  const mergeLayers = async () => {
    const ids = [...new Set([...selectedObjects, ...(active ? [active] : [])])];
    if (ids.length < 2) {
      notify('Выделите в «Слоях» два слоя или больше: Shift-щелчок', false);
      return;
    }
    try {
      const { id } = await post<{ id: string }>('/api/objects/merge', { ids });
      const seq = ++refreshSeq.current;
      const s = await getState();
      if (seq === refreshSeq.current) setState(s);
      const o = s.objects.find((x) => x.id === id);
      if (o) enterLayer(o);
      notify('Слои объединены. ⌘Z вернёт их', false);
    } catch (err) {
      fail(err);
    }
  };
  /** Влить слой в фон: то, что от него видно, становится исходником */
  const mergeDown = (o: ObjectDto | undefined) => {
    if (!o) {
      notify('Откройте слой: щелчок по нему', false);
      return;
    }
    post(`/api/objects/${o.id}/merge-down`).then(() => {
      if (active === o.id) setActive(null);
      clearSelection();
      notify(`«${short(o.name)}» влит в фон. ⌘Z вернёт`, false);
    }, fail);
  };
  /** Свести все слои в плоскую картинку */
  const flatten = () =>
    post('/api/doc/flatten').then(() => {
      setActive(null);
      clearSelection();
      notify('Слои сведены. ⌘Z вернёт их', false);
    }, fail);
  /**
   * Щелчок по слою в списке — работа в нём: его маска становится выделением; с ⌘ или Shift — маска добавляется
   * к выделению или убирается из него, а слой, в котором работают, тот же
   */
  const selectObject = (o: ObjectDto, add: boolean) => {
    const shape = objectShape(o);
    if (add) {
      // Несколько слоёв вместе правят новым слоем поверх них
      const has = selection.some((s) => s.kind === 'mask' && s.id === shape.id && !s.erase);
      if (!has) formOrder.current.push('shape');
      updateSelection((sel) => (has ? sel.filter((s) => !(s.kind === 'mask' && s.id === shape.id)) : [...sel, shape]));
      setActive(null);
    } else {
      enterLayer(o);
      viewRef.current?.reveal(o.rect);
    }
  };
  /** Работа в слое: он выделен целиком, генерация ляжет его версией */
  const enterLayer = (o: ObjectDto) => {
    formOrder.current = formOrder.current.filter((k) => k !== 'shape');
    formOrder.current.push('shape');
    updateSelection(() => [objectShape(o)]);
    setActive(o.id);
  };
  const selectedObjects = new Set(selection.flatMap((s) => (s.kind === 'mask' && s.id.startsWith('obj:') && !s.erase ? [s.id.slice(4)] : [])));

  /** Дорисовать фон под слоем: модель нарисует то, что за ним, — тогда слой можно сдвигать и скрывать */
  const detach = async (o: ObjectDto) => {
    if (needsKey(model) && !state?.hasKey) {
      setDialog('settings');
      return;
    }
    try {
      await post(`/api/objects/${o.id}/detach`, { variants, model, size: sizeFor(model) });
    } catch (err) {
      fail(err);
    }
  };
  onMove.current = (id, dx, dy) =>
    post<{ rev: number }>(`/api/objects/${id}/move`, { dx, dy }).then(
      (r) => r.rev,
      (err: unknown) => {
        fail(err);
        throw err;
      },
    );
  const clearSketch = () => {
    formOrder.current = formOrder.current.filter((k) => k !== 'sketch');
    setSketch([]);
  };
  /** ⌘Z в форме новой правки: последняя фигура или последний штрих наброска */
  const undoForm = () => {
    const last = formOrder.current.pop() ?? (selection.length ? 'shape' : 'sketch');
    if (last === 'sketch') setSketch((s) => s.slice(0, -1));
    else setSelection((s) => s.slice(0, -1));
  };
  onMaskShape.current = (view, shape) =>
    post<MaskEditResult>(view.kind === 'job' ? `/api/jobs/${view.target}/mask` : `/api/history/${view.target}/mask`, { shapes: [shape] }).catch(
      (err: unknown) => {
        fail(err);
        throw err;
      },
    );
  /** Маску правимого слоя или задачи поменяли не мазки — превью перезапросит её */
  const maskChanged = () => viewRef.current?.maskChanged();

  const hasSelection = selection.some((s) => !s.erase);
  const hasSketch = sketch.some((s) => !s.erase);
  const canGenerate = !!doc && hasSelection && prompt.trim().length > 0 && !maskLayer;
  // Директор идёт через Codex; у подставной модели — подставной директор
  const canDirect = state?.provider === 'mock' || !!state?.codex;
  // С директором правка идёт шагами с критиком, а не вариантами разом
  const stepwise = director && canDirect;
  const countFor = (withDirector: boolean) => (withDirector ? steps : variants);
  // У ChatGPT одно разрешение — его выбирает сама модель
  const sizeFor = (m: ModelChoice): SizeChoice => (m === 'chatgpt' ? 'auto' : size);
  const sizeAdvice = doc && state && hasSelection ? adviseSelection(doc, selection, state.models[model], sizeFor(model)) : null;
  // Рамка куска, который увидит модель, — на холсте, пока есть выделение
  const modelFrame = sizeAdvice && typeof sizeAdvice === 'object' && !maskLayer ? sizeAdvice.frame.inside : null;
  useEffect(() => viewRef.current?.setModelFrame(modelFrame), [JSON.stringify(modelFrame)]);

  const generate = async () => {
    if (!canGenerate) return;
    if (needsKey(model) && !state?.hasKey) {
      setDialog('settings');
      return;
    }
    try {
      await post('/api/jobs', {
        shapes: selection,
        object: activeObj?.id,
        prompt,
        variants: countFor(stepwise),
        model,
        size: sizeFor(model),
        refs,
        hide,
        sketch: hasSketch ? sketch : undefined,
        director: stepwise,
      });
      // Форма — для следующей области: задача, набросок, референсы и скрытие у неё свои; модель, разрешение, число вариантов и директор остаются
      setSelection([]);
      setSketch([]);
      formOrder.current = [];
      setPrompt('');
      setRefs([]);
      setHide(false);
    } catch (err) {
      fail(err);
    }
  };

  // Правки маски слоя — обычные шаги истории документа, поэтому в режиме маски слоя ⌘Z отменяет их
  const undo = () => {
    if ((selection.length || sketch.length) && !maskLayer) undoForm();
    else if (state?.canUndo) post('/api/history/undo').then(maskChanged, fail);
  };
  const redo = () => {
    if (state?.canRedo) post('/api/history/redo').then(maskChanged, fail);
  };

  // Без окон выбора файла (интерфейс в браузере для разработки) «Сохранить как» — скачивание:
  // документ со слоями — проектом .caaa, без слоёв — PNG
  const download = (ext: 'png' | 'caaa') => {
    const a = document.createElement('a');
    a.href = `/api/doc/export.${ext}`;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const openDialog = () => {
    if (state?.nativeFiles) post('/api/doc/open').catch(fail);
    else fileRef.current?.click();
  };

  const openRecent = (id: string) => post(`/api/recent/${id}/open`).catch(fail);

  const save = async (how: 'save' | 'save-as' | 'export') => {
    if (!doc) return;
    if (!state?.nativeFiles && (how !== 'save' || !doc.path || doc.saveBlocker)) {
      download(how !== 'export' && layers.length ? 'caaa' : 'png');
      return;
    }
    try {
      const { path } = await post<{ path: string | null }>(`/api/doc/${how}`);
      if (path) notify(`${how === 'export' ? 'Экспортировано' : 'Сохранено'}: ${fileName(path)}`, false);
    } catch (err) {
      fail(err);
    }
  };

  const addReferences = async (files: Iterable<File>) => {
    const images = [...files].filter((f) => f.type.startsWith('image/'));
    if (!images.length) return;
    const room = MAX_REFERENCES - refs.length;
    if (room <= 0) {
      notify(`Не больше ${MAX_REFERENCES} референсов на правку`);
      return;
    }
    if (images.length > room) notify(`Добавлю только ${room}: не больше ${MAX_REFERENCES} референсов на правку`);
    try {
      for (const file of images.slice(0, room)) {
        const { id } = await uploadReference(file);
        setRefs((r) => [...r, id]);
      }
    } catch (err) {
      fail(err);
    }
  };

  // Команды из меню приложения и те же действия с клавиатуры
  const run = (command: AppCommand) => {
    const view = viewRef.current;
    const editing = document.activeElement instanceof HTMLTextAreaElement || document.activeElement instanceof HTMLInputElement;
    switch (command) {
      case 'settings':
        setDialog('settings');
        break;
      case 'open':
        openDialog();
        break;
      case 'new':
        setDialog('new');
        break;
      case 'save':
      case 'save-as':
      case 'export':
        void save(command);
        break;
      case 'undo':
        if (editing) document.execCommand('undo');
        else undo();
        break;
      case 'redo':
        if (editing) document.execCommand('redo');
        else redo();
        break;
      case 'deselect':
        clearSelection();
        break;
      case 'save-object':
        void saveObject();
        break;
      case 'cut-object':
        void cutObject();
        break;
      case 'merge-layers':
        void mergeLayers();
        break;
      case 'merge-down':
        mergeDown(activeObj ?? (selectedObjects.size === 1 ? objects.find((x) => selectedObjects.has(x.id)) : undefined));
        break;
      case 'flatten':
        void flatten();
        break;
      case 'zoom-fit':
        view?.fit();
        break;
      case 'zoom-100':
        view?.zoomTo(100);
        break;
      case 'zoom-50':
        view?.zoomTo(50);
        break;
      case 'zoom-in':
        view?.zoomBy(2);
        break;
      case 'zoom-out':
        view?.zoomBy(0.5);
        break;
      default:
        if (command.startsWith('open-recent:')) void openRecent(command.slice('open-recent:'.length));
    }
  };
  const commands = useRef(run);
  commands.current = run;
  useEffect(() => {
    const onCommand = (e: Event) => commands.current((e as CustomEvent<AppCommand>).detail);
    window.addEventListener(COMMAND_EVENT, onCommand);
    return () => window.removeEventListener(COMMAND_EVENT, onCommand);
  }, []);

  // Картинка из буфера обмена (⌘V) становится референсом
  const onPaste = useRef<(e: ClipboardEvent) => void>(() => undefined);
  onPaste.current = (e) => {
    const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length || !doc) return;
    e.preventDefault();
    void addReferences(files);
  };
  useEffect(() => {
    const paste = (e: ClipboardEvent) => onPaste.current(e);
    window.addEventListener('paste', paste);
    return () => window.removeEventListener('paste', paste);
  }, []);

  /** ← и → — версия выделенного слоя: исходник и версии по кругу */
  const stepVersion = (o: ObjectDto, dir: number) => {
    const all: (string | null)[] = [null, ...o.versions];
    const i = all.indexOf(o.current ?? null);
    const patch = all[(i + dir + all.length) % all.length] ?? null;
    if (patch !== (o.current ?? null)) post(`/api/objects/${o.id}/current`, { patch }).catch(fail);
  };

  // Горячие клавиши
  const keys = useRef<(e: KeyboardEvent, down: boolean) => void>(() => undefined);
  keys.current = (e, down) => {
    const typing = e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement;
    const mod = e.metaKey || e.ctrlKey;
    if (e.code === 'Space' && !typing) {
      e.preventDefault();
      viewRef.current?.setSpace(down);
      return;
    }
    // Пока держат «\» — на холсте исходник всей картинки
    if (e.code === 'Backslash' && !typing && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      if (e.repeat) return;
      viewRef.current?.setCompare(down);
      setComparing(down);
      return;
    }
    if (!down) return;
    if (mod && e.key === 'Enter') {
      e.preventDefault();
      void generate();
      return;
    }
    if (e.key === 'Escape') {
      if (zoomMenu) setZoomMenu(false);
      else if (dialog) setDialog(null);
      else if (maskLayer) setMaskLayer(null);
      // Сначала снимается выделение, потом — работа в слое
      else if (selection.length || !activeObj) clearSelection();
      else setActive(null);
      (document.activeElement as HTMLElement | null)?.blur();
      return;
    }
    // Те же сочетания, что показаны в меню; работают и когда фокус в поле ввода
    if (mod) {
      const key = e.key.toLowerCase();
      const byKey: Record<string, AppCommand> = {
        ',': 'settings',
        o: 'open',
        n: 'new',
        s: 'save',
        d: 'deselect',
        j: 'save-object',
        e: 'merge-layers',
        '0': 'zoom-fit',
        '1': 'zoom-100',
        '2': 'zoom-50',
        '=': 'zoom-in',
        '+': 'zoom-in',
        '-': 'zoom-out',
      };
      const command =
        e.shiftKey && key === 's' ? 'save-as' : e.shiftKey && key === 'e' ? 'export' : e.shiftKey && key === 'j' ? 'cut-object' : e.shiftKey || e.altKey ? undefined : byKey[key];
      if (command) {
        e.preventDefault();
        run(command);
        return;
      }
    }
    if (typing || dialog) return;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if (mod) return;
    // По коду клавиши — в русской раскладке тоже
    const t = TOOLS.find((x) => e.code === `Key${x.key}` || e.key.toLowerCase() === x.key.toLowerCase());
    if (t) setTool(t.id);
    // [ и ] — размер кисти, с Shift — жёсткость, как в Photoshop: ⇧[ мягче, ⇧] жёстче. По коду клавиши — в русской раскладке тоже
    if (e.code === 'BracketLeft' || e.code === 'BracketRight') {
      const up = e.code === 'BracketRight';
      if (tool === 'object') stepLevel(up ? 1 : -1);
      else if (e.shiftKey) setSoftness((v) => Math.min(1, Math.max(0, Math.round((v + (up ? -0.25 : 0.25)) * 4) / 4)));
      else if (tool === 'sketch') setSketchSize((b) => (up ? Math.min(120, Math.round(b * 1.25) + 1) : Math.max(2, Math.round(b / 1.25))));
      else setBrush((b) => (up ? Math.min(400, Math.round(b * 1.25)) : Math.max(4, Math.round(b / 1.25))));
    }
    if (activeObj && activeObj.versions.length > 0 && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      stepVersion(activeObj, e.key === 'ArrowLeft' ? -1 : 1);
    }
  };
  useEffect(() => {
    const down = (e: KeyboardEvent) => keys.current(e, true);
    const up = (e: KeyboardEvent) => keys.current(e, false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  // В браузере (сервер для разработки) вопрос о несохранённом задаёт сам браузер; в приложении — окно Electron
  const unsaved = !state?.nativeFiles && !!doc && (doc.dirty || jobs.length > 0);
  useEffect(() => {
    if (!unsaved) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [unsaved]);

  // Загрузка из браузера — только когда нет окон выбора файла (интерфейс для разработки)
  const openFile = async (file: File) => {
    setBusy(`Открываю ${file.name}…`);
    try {
      await upload(file);
      refresh();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  };

  const saveStyle = (value: string) => {
    window.clearTimeout(styleTimer.current);
    styleTimer.current = window.setTimeout(() => post('/api/doc/style', { style: value }).catch(fail), 600);
  };

  // Маску версии правят прежде всего, чтобы скрыть кусок, поэтому сразу ластик
  const editLayerMask = (patch: PatchDto) => {
    if (maskLayer === patch.id) {
      setMaskLayer(null);
      return;
    }
    setMaskLayer(patch.id);
    setTool('eraser');
    viewRef.current?.reveal(patch.rect);
  };

  const focus = (job: JobDto) => {
    const r = job.inside ?? job.bbox;
    if (r) viewRef.current?.showRect(r);
  };

  /** Ещё варианты (с директором — шаги) задачи в очереди, можно с поправкой; с ошибкой до подготовки куска — начать её заново */
  const redoJob = (job: JobDto, change: RedoChange = {}) =>
    job.inside
      ? post(`/api/jobs/${job.id}/more`, { count: countFor(change.director ?? job.director), ...change })
      : post(`/api/jobs/${job.id}/retry`, change);

  // Ещё варианты версии, можно с поправкой: если они уже в очереди — туда же, а не второй задачей на ту же версию
  const layerVariants = async (patch: PatchDto, change: RedoChange = {}) => {
    if (needsKey(patch.model ?? model) && !state?.hasKey) {
      setDialog('settings');
      return;
    }
    const open = jobs.find((j) => j.from === patch.id);
    try {
      if (open) {
        focus(open);
        const idle = (open.status === 'done' || open.status === 'error') && !open.variants.some((v) => v.status === 'running');
        if (idle) await redoJob(open, change);
        else notify('Варианты этой версии уже генерируются', false);
        return;
      }
      const count = countFor(change.director ?? patch.directed !== undefined);
      await post(`/api/history/${patch.id}/variants`, { variants: count, model, size: sizeFor(model), ...change });
      viewRef.current?.showRect(patch.rect);
    } catch (err) {
      fail(err);
    }
  };

  const deleteVersion = (patch: PatchDto) => {
    post(`/api/history/${patch.id}/delete`)
      .then(() => notify('Версия удалена. ⌘Z вернёт её', false))
      .catch(fail);
  };
  const deleteObject = (o: ObjectDto) => {
    post(`/api/objects/${o.id}/delete`)
      .then(() => notify(`Слой «${short(o.name)}» ${o.filled ? 'убран с холста' : 'удалён'}. ⌘Z вернёт его`, false))
      .catch(fail);
  };
  const expandVersion = (patch: PatchDto) => {
    post<{ addedPx: number }>(`/api/history/${patch.id}/expand`)
      .then(({ addedPx }) => {
        if (addedPx) maskChanged();
        const area = patch.rect.width * patch.rect.height;
        notify(addedPx ? `Маска выросла на ${((100 * addedPx) / area).toFixed(1)}% куска` : 'За краем маски модель ничего не дорисовала', false);
      })
      .catch(fail);
  };

  return (
    <div class="app">
      <header class="topbar">
        <div class="doc-title" title={doc?.path ?? undefined}>
          {doc ? (
            <>
              <strong>{doc.name}</strong>
              {doc.dirty && (
                <span class="unsaved" title="Принятые правки ещё не записаны в файл (⌘S)">
                  не сохранено
                </span>
              )}
              <span class="dim">
                {doc.width}×{doc.height}
              </span>
            </>
          ) : (
            <strong>canvaaaas</strong>
          )}
        </div>
        <div class="topbar-actions">
          {doc && (
            <>
              <span class="sep" />
              <button
                class="ghost icon"
                title="Отменить (⌘Z)"
                aria-label="Отменить"
                disabled={!state?.canUndo && !selection.length && !sketch.length}
                onClick={undo}
              >
                <IconArrowBackUp size={20} stroke={STROKE} />
              </button>
              <button class="ghost icon" title="Повторить (⇧⌘Z)" aria-label="Повторить" disabled={!state?.canRedo} onClick={redo}>
                <IconArrowForwardUp size={20} stroke={STROKE} />
              </button>
              <span class="sep" />
              <div class="zoom-control">
                <button class="ghost icon" title="Уменьшить (⌘−)" aria-label="Уменьшить" onClick={() => run('zoom-out')}>
                  <IconMinus size={18} stroke={STROKE} />
                </button>
                <button
                  class="ghost zoom"
                  title="Масштаб"
                  aria-haspopup="menu"
                  aria-expanded={zoomMenu}
                  onClick={() => setZoomMenu((v) => !v)}
                >
                  {zoom}%
                </button>
                <button class="ghost icon" title="Увеличить (⌘=)" aria-label="Увеличить" onClick={() => run('zoom-in')}>
                  <IconPlus size={18} stroke={STROKE} />
                </button>
                {zoomMenu && (
                  <ul class="zoom-menu" role="menu" onClick={() => setZoomMenu(false)}>
                    <li role="menuitem" onClick={() => run('zoom-fit')}>
                      Вписать в окно <kbd>⌘0</kbd>
                    </li>
                    {[25, 50, 100, 200, 400].map((p) => (
                      <li role="menuitem" onClick={() => viewRef.current?.zoomTo(p)}>
                        {p}% {p === 100 && <kbd>⌘1</kbd>}
                        {p === 50 && <kbd>⌘2</kbd>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <span class="sep" />
              <button
                class={doc.dirty ? 'ghost save-pending' : 'ghost'}
                title={doc.path && !doc.saveBlocker ? `Записать в ${fileName(doc.path)} (⌘S)` : 'Сохранить в файл (⌘S)'}
                onClick={() => void save('save')}
              >
                Сохранить
              </button>
            </>
          )}
        </div>
        <div class="counter" title="Каждая генерация платная">
          {state?.provider === 'mock' && <span class="badge">подставная модель</span>}
          Генераций: {state?.generations.session ?? 0} за сеанс, {state?.generations.today ?? 0} сегодня
        </div>
      </header>

      <div class="optbar" role="toolbar" aria-label="Настройки инструмента">
        {doc &&
          (editedLayer ? (
            <>
              <span class="opt-title">
                <IconMask size={16} stroke={STROKE} aria-hidden="true" />
                {`Маска «${short(objects.find((o) => o.id === editedLayer.object)?.name ?? editedLayer.prompt, 24)}»`}
                <Help>Ластик и Alt скрывают часть версии, кисть и фигуры возвращают её — и за краем прежнего выделения. ⌘Z отменяет мазок.</Help>
              </span>
              {(tool === 'brush' || tool === 'eraser') && (
                <>
                  <span class="opt-sep" />
                  <Slider label="Размер" title="Размер кисти на экране ([ и ])" min={4} max={400} value={brush} onChange={setBrush} />
                  <Slider
                    label="Мягкость"
                    title="0% — жёсткий край, 100% — затухает от середины (⇧[ и ⇧])"
                    min={0}
                    max={100}
                    step={5}
                    value={Math.round(softness * 100)}
                    unit="%"
                    onChange={(v) => setSoftness(v / 100)}
                  />
                </>
              )}
              <button class="opt-done" onClick={() => setMaskLayer(null)}>
                Готово
              </button>
            </>
          ) : (
            <>
              <span class="opt-title">
                {(() => {
                  const ToolIcon = TOOL_ICONS[tool];
                  return <ToolIcon size={16} stroke={STROKE} aria-hidden="true" />;
                })()}
                {TOOLS.find((t) => t.id === tool)?.name}
              </span>
              {SELECTING.includes(tool) && tool !== 'eraser' && (
                <>
                  <span class="opt-sep" />
                  <Seg
                    label="Режим выделения"
                    value={tool === 'brush' && selectMode === 'new' ? 'add' : selectMode}
                    options={[
                      ...(tool === 'brush' ? [] : [{ value: 'new' as const, icon: IconSquare, title: 'Новое выделение' }]),
                      { value: 'add' as const, icon: IconLayersUnion, title: 'Добавить к выделению (Shift)' },
                      { value: 'sub' as const, icon: IconLayersSubtract, title: 'Вычесть из выделения (Alt)' },
                    ]}
                    onChange={setSelectMode}
                  />
                </>
              )}
              {tool === 'object' && (
                <>
                  {currentPick && currentPick.levels.length > 1 && (
                    <Seg
                      label="Уровень объекта"
                      value={currentPick.level}
                      options={levelNames(currentPick.levels.length).map((name, i) => ({ value: i, text: name, title: 'Мельче или крупнее: [ и ] или щелчок туда же' }))}
                      onChange={(i) => stepLevel(i - currentPick.level)}
                    />
                  )}
                  <OptCheck label="По линиям" title="Край выделения — по линиям рисунка, с контуром" checked={objectSnap} onChange={setObjectSnap} />
                </>
              )}
              {(tool === 'brush' || tool === 'eraser') && (
                <>
                  <Slider label="Размер" title="Размер кисти на экране ([ и ])" min={4} max={400} value={brush} onChange={setBrush} />
                  <OptCheck label="По линиям" title="Клетки рисунка, которые задел мазок, — целиком, с контуром" checked={brushSnap} onChange={setBrushSnap} />
                </>
              )}
              {tool === 'sketch' && (
                <>
                  <span class="opt-sep" />
                  <Slider label="Толщина" title="Толщина наброска на экране ([ и ])" min={2} max={120} value={sketchSize} onChange={setSketchSize} />
                  <div class="sketch-colors" role="radiogroup" aria-label="Цвет наброска">
                    {SKETCH_COLORS.map((c) => (
                      <button
                        key={c}
                        role="radio"
                        aria-checked={sketchColor === c}
                        aria-label={c}
                        class={sketchColor === c ? 'swatch active' : 'swatch'}
                        style={{ background: c }}
                        onClick={() => setSketchColor(c)}
                      />
                    ))}
                    <label class={SKETCH_COLORS.includes(sketchColor) ? 'swatch custom' : 'swatch custom active'} title="Другой цвет" style={{ background: sketchColor }}>
                      <input type="color" value={sketchColor} aria-label="Другой цвет наброска" onInput={(e) => setSketchColor(e.currentTarget.value)} />
                    </label>
                  </div>
                </>
              )}
              {SELECTING.includes(tool) && hasSelection && (
                <>
                  <span class="opt-sep" />
                  <EdgeControl px={edgePx} onChange={changeEdge} />
                </>
              )}
              {selection.length > 0 && (
                <span class="opt-actions">
                  {hasSelection && !(selectedObjects.size === 1 && selection.length === 1) && (
                    <>
                      <button class="icon" title="Слой из выделения: копия того, что видно (⌘J)" aria-label="Слой из выделения" onClick={() => void saveObject()}>
                        <IconCubePlus size={16} stroke={STROKE} />
                      </button>
                      <button class="icon" title="Вырезать в слой: под ним модель дорисует фон (⌘⇧J)" aria-label="Вырезать в слой" onClick={() => void cutObject()}>
                        <IconScissors size={16} stroke={STROKE} />
                      </button>
                    </>
                  )}
                  <button class="icon" title="Снять выделение (⌘D)" aria-label="Снять выделение" onClick={clearSelection}>
                    <IconMarqueeOff size={16} stroke={STROKE} />
                  </button>
                </span>
              )}
            </>
          ))}
      </div>

      <nav class="rail" aria-label="Инструменты">
        {TOOLS.map((t) => {
          const ToolIcon = TOOL_ICONS[t.id];
          // Набросок — подсказка модели к новой правке, а не выделение: отдельно от инструментов выделения.
          // Набросок, «Палочка» и «Сдвинуть» — не для правки маски
          const formOnly = (t.id === 'sketch' || t.id === 'object' || t.id === 'move') && !!maskLayer;
          const button = (
            <button
              key={t.id}
              class={tool === t.id ? 'tool active' : 'tool'}
              title={formOnly ? `${t.label} — только для новой правки` : `${t.label} (${t.key})`}
              aria-label={t.label}
              aria-pressed={tool === t.id}
              disabled={formOnly}
              onClick={() => setTool(t.id)}
            >
              <ToolIcon size={22} stroke={STROKE} />
            </button>
          );
          return t.id === 'sketch' ? [<span class="rail-sep" key="sep" />, button] : button;
        })}
      </nav>

      <main class={maskLayer ? 'stage mask-mode' : 'stage'}>
        <div ref={stageRef} class="osd" />
        {doc && tool === 'object' && segment && !maskLayer && segment.status !== 'ready' && <SegmentBanner segment={segment} onError={fail} />}
        {comparing && <div class="stage-banner">Исходник</div>}
        {activeObj && !maskLayer && (
          <div class="stage-banner layer-banner">
            <IconStack2 size={16} stroke={STROKE} aria-hidden="true" />
            {`Слой «${short(activeObj.name, 32)}»`}
            <button class="layer-banner-close" title="Выйти из слоя" aria-label="Выйти из слоя" onClick={() => setActive(null)}>
              <IconX size={14} stroke={2.25} />
            </button>
          </div>
        )}
        {!doc && state && <StartScreen recent={state.recent} onOpen={openDialog} onOpenRecent={openRecent} onError={fail} />}
        {(busy ?? state?.activity) && <div class="busy">{busy ?? state?.activity}</div>}
        {toast && <div class={toast.error ? 'toast error' : 'toast'}>{toast.text}</div>}
      </main>

      <aside class="side">
        {state && !state.hasKey && needsKey(model) && (
          <section class="panel notice">
            <h2>Нужен ключ laozhang.ai</h2>
            <p class="hint">Без него не работает Nano Banana. ChatGPT Images идёт по подписке, ключ ему не нужен.</p>
            <button class="primary" onClick={() => setDialog('settings')}>
              Открыть настройки
            </button>
          </section>
        )}
        {doc && (
          <>
            <section class="panel">
              <h2>Стиль документа</h2>
              <textarea
                rows={2}
                placeholder="Например: книжная иллюстрация, тёплый вечерний свет"
                value={styleDraft}
                onInput={(e) => {
                  setStyleDraft(e.currentTarget.value);
                  saveStyle(e.currentTarget.value);
                }}
              />
            </section>

            <section
              class="panel"
              onDragOver={(e) => {
                if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
              }}
              onDrop={(e) => {
                e.preventDefault();
                void addReferences(e.dataTransfer?.files ?? []);
              }}
            >
              <h2>
                Новая правка
                <Help>
                  Выделите предмет «Палочкой» (W), область — прямоугольником (R), лассо (L) или кистью (B). Shift добавляет к
                  выделению, Alt вычитает; режим и край выделения — на панели над холстом. Набросок (S) — подсказка
                  модели: где и каким должно быть то, что в задаче; с Alt он стирается. Модель видит кусок в пунктирной рамке, меняет —
                  только выделенное. Палочка по слою открывает его, и правка ложится его версией; по фону — новым слоем. ⌘Z убирает
                  последнее, ⌘D снимает выделение, ⌘↵ — сгенерировать.
                </Help>
              </h2>
              {sketch.length > 0 && (
                <div class="chips">
                  <Chip icon={IconScribble} label="Набросок" clear="Стереть набросок" onClear={clearSketch} />
                </div>
              )}
              <textarea rows={3} placeholder="Что должно получиться" value={prompt} onInput={(e) => setPrompt(e.currentTarget.value)} />
              <div class="checks">
                <HideOption checked={hide} onChange={setHide} />
                <DirectorOption checked={director && canDirect} disabled={!canDirect} onChange={setDirector} />
              </div>
              <div class="refs">
                {refs.map((id) => (
                  <figure class="ref">
                    <img src={`/api/refs/${id}/thumb.jpg`} alt="Референс" />
                    <button class="ref-remove" aria-label="Убрать референс" onClick={() => setRefs((r) => r.filter((x) => x !== id))}>
                      <IconX size={12} stroke={2.25} />
                    </button>
                  </figure>
                ))}
                {refs.length < MAX_REFERENCES && (
                  <button class="ref-add" title="Или перетащите картинку сюда, или вставьте её через ⌘V" onClick={() => refRef.current?.click()}>
                    <IconPhotoPlus size={18} stroke={STROKE} />
                    Референс
                  </button>
                )}
              </div>
              <div class="options">
                <label>
                  Модель
                  <select value={model} onChange={(e) => setModel(e.currentTarget.value as ModelChoice)}>
                    {MODELS.map((m) => (
                      <option value={m.id}>{m.label}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Разрешение
                  {model === 'chatgpt' ? (
                    <select disabled title="Разрешение ответа ChatGPT выбирает сам: около 1,6 мегапикселя в пропорциях куска">
                      <option>Само, ~1,6 Мп</option>
                    </select>
                  ) : (
                    <select value={size} onChange={(e) => setSize(e.currentTarget.value as SizeChoice)}>
                      <option value="auto">Авто, до 2K</option>
                      <option value="1K">1K</option>
                      <option value="2K">2K</option>
                      <option value="4K">4K, 4–5 мин</option>
                    </select>
                  )}
                </label>
                <label>
                  {stepwise ? 'Шаги' : 'Варианты'}
                  <select
                    value={countFor(stepwise)}
                    onChange={(e) => (stepwise ? setSteps : setVariants)(Number(e.currentTarget.value))}
                  >
                    {[1, 2, 3, 4].map((n) => (
                      <option value={n}>{n}</option>
                    ))}
                  </select>
                </label>
              </div>
              {typeof sizeAdvice === 'string' && <p class="job-warning">{sizeAdvice}</p>}
              {sizeAdvice && typeof sizeAdvice === 'object' && (
                <SizeHint advice={sizeAdvice} auto={sizeFor(model) === 'auto'} sizes={state!.models[model].imageSizes} onSize={setSize} />
              )}
              {activeObj ? (
                <div class="chips">
                  <Chip icon={IconStack2} label={`В слой «${short(activeObj.name, 28)}»`} clear="Новым слоем" onClear={() => setActive(null)} />
                </div>
              ) : (
                hasSelection && (
                  <div class="chips">
                    <span class="chip plain">
                      <IconStackPlus size={14} stroke={STROKE} aria-hidden="true" />
                      {prompt.trim() ? `Новый слой «${short(layerName(prompt), 28)}»` : 'Новый слой'}
                    </span>
                  </div>
                )
              )}
              <button class="primary" disabled={!canGenerate} onClick={generate} title="⌘↵">
                {generateText(stepwise, countFor(stepwise))}
              </button>
            </section>

            <LayersPanel
              doc={doc}
              objects={objects}
              patches={layers}
              jobs={jobs}
              active={active}
              picked={selectedObjects}
              maskLayer={maskLayer}
              canDirect={canDirect}
              variants={variants}
              steps={steps}
              onSelect={selectObject}
              onHover={(o) => setLitObject(o?.id ?? null)}
              onRename={(o, name) => post(`/api/objects/${o.id}/rename`, { name }).catch(fail)}
              onHidden={(o, hidden) => post(`/api/objects/${o.id}/hidden`, { hidden }).catch(fail)}
              onCurrent={(o, patch) => post(`/api/objects/${o.id}/current`, { patch }).catch(fail)}
              onMask={editLayerMask}
              onMore={(patch, change) => void layerVariants(patch, change)}
              onExpand={expandVersion}
              onFill={(o) => void detach(o)}
              onDeleteVersion={deleteVersion}
              onMergeDown={mergeDown}
              onDelete={deleteObject}
              onMerge={() => void mergeLayers()}
              onJob={(job, action) => {
                if ((action === 'retry' || action === 'more') && needsKey(job.model) && !state?.hasKey) setDialog('settings');
                else post(`/api/jobs/${job.id}/${action}`, action === 'more' ? { count: countFor(job.director) } : undefined).catch(fail);
              }}
              onShowJob={focus}
            />
          </>
        )}
      </aside>

      {dialog === 'settings' && state && (
        <SettingsDialog
          hasKey={state.hasKey}
          codex={state.codex}
          onClose={() => setDialog(null)}
          onSaved={(text) => {
            setDialog(null);
            notify(text, false);
          }}
          onError={fail}
        />
      )}
      {dialog === 'new' && (
        <div class="modal-backdrop" onClick={() => setDialog(null)}>
          <div class="modal wide" role="dialog" aria-modal="true" aria-labelledby="new-title" onClick={(e) => e.stopPropagation()}>
            <h2 id="new-title">Новый холст</h2>
            <NewCanvasForm
              onError={fail}
              onCreated={() => setDialog(null)}
              extra={
                <button type="button" onClick={() => setDialog(null)}>
                  Отмена
                </button>
              }
            />
          </div>
        </div>
      )}
      {zoomMenu && <div class="click-catcher" onClick={() => setZoomMenu(false)} />}

      <input
        ref={refRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.currentTarget.files ?? [])];
          e.currentTarget.value = '';
          void addReferences(files);
        }}
      />

      <input
        ref={fileRef}
        type="file"
        accept=".caaa,image/png,image/jpeg,image/webp,image/tiff"
        hidden
        onChange={(e) => {
          const file = e.currentTarget.files?.[0];
          e.currentTarget.value = '';
          if (file) void openFile(file);
        }}
      />
    </div>
  );
}

/** Переключатель на панели настроек: кнопки подряд, одна выбрана */
function Seg<T extends string | number>(props: {
  label: string;
  value: T;
  options: { value: T; icon?: Icon; text?: string; title: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <span class="seg" role="radiogroup" aria-label={props.label}>
      {props.options.map((o) => (
        <button
          key={String(o.value)}
          role="radio"
          aria-checked={props.value === o.value}
          aria-label={o.text ? undefined : o.title}
          title={o.title}
          class={props.value === o.value ? 'on' : ''}
          onClick={() => props.onChange(o.value)}
        >
          {o.icon && <o.icon size={16} stroke={STROKE} aria-hidden="true" />}
          {o.text}
        </button>
      ))}
    </span>
  );
}

/** Ползунок с подписью и числом на панели настроек */
function Slider(props: { label: string; title: string; min: number; max: number; step?: number; value: number; unit?: string; onChange: (value: number) => void }) {
  return (
    <label class="opt-slider" title={props.title}>
      <span>{props.label}</span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        value={props.value}
        aria-label={props.label}
        onInput={(e) => props.onChange(Number(e.currentTarget.value))}
      />
      <span class="opt-value">
        {props.value}
        {props.unit}
      </span>
    </label>
  );
}

function OptCheck(props: { label: string; title: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label class="opt-check" title={props.title}>
      <input type="checkbox" checked={props.checked} onChange={(e) => props.onChange(e.currentTarget.checked)} />
      {props.label}
    </label>
  );
}

/** Край всего выделения: шире или уже на столько пикселей холста */
function EdgeControl(props: { px: number; onChange: (px: number) => void }) {
  return (
    <span class="opt-edge" title="Край выделения шире или уже, пиксели холста">
      <span>Край</span>
      <button class="icon" aria-label="Уже" onClick={() => props.onChange(props.px - 1)}>
        <IconMinus size={14} stroke={STROKE} />
      </button>
      <input
        type="number"
        min={-100}
        max={100}
        value={props.px}
        aria-label="Край выделения, пиксели"
        onChange={(e) => props.onChange(Number(e.currentTarget.value))}
      />
      <button class="icon" aria-label="Шире" onClick={() => props.onChange(props.px + 1)}>
        <IconPlus size={14} stroke={STROKE} />
      </button>
    </span>
  );
}

/** Модель выделения объектов: скачать, ход скачивания и загрузки, ошибка */
function SegmentBanner(props: { segment: StateDto['segment']; onError: (err: unknown) => void }) {
  const { segment } = props;
  const install = () => post('/api/segment/install').catch(props.onError);
  if (segment.status === 'downloading') return <div class="stage-banner">Скачиваю модель… {Math.round((segment.progress ?? 0) * 100)}%</div>;
  if (segment.status === 'loading') return <div class="stage-banner">Загружаю модель…</div>;
  return (
    <div class={segment.status === 'error' ? 'stage-banner error' : 'stage-banner'}>
      {segment.status === 'error' ? short(segment.error ?? 'Ошибка', 80) : 'Нужна модель выделения, 272 МБ'}
      <Help>
        Объекты выделяет SAM 2.1 от Meta — прямо на компьютере, без интернета и без генераций. Модель скачивается один раз в папку
        данных приложения.
      </Help>
      <button onClick={install}>{segment.status === 'error' ? 'Повторить' : 'Скачать'}</button>
    </div>
  );
}

type JobAction = 'discard' | 'retry' | 'more' | 'stop';

/** У задачи что-то идёт: законченные интерфейс убирает сам — их варианты уже версии слоёв */
function busyJob(job: JobDto): boolean {
  return job.status === 'queued' || job.status === 'preparing' || job.status === 'running' || !!job.chain || job.variants.some((v) => v.status === 'running');
}

/** Сколько плиток «идёт» у задачи: по одной на вариант в работе; пока вариантов нет — одна */
function runningTiles(job: JobDto): number {
  if (!busyJob(job)) return 0;
  return job.variants.filter((v) => v.status === 'running').length || 1;
}

/** Миниатюра слоя или версии; без картинки — значок */
function Thumb(props: { src?: string; icon?: Icon; spin?: boolean }) {
  const Glyph = props.icon ?? IconStack2;
  return (
    <span class="thumb">
      {props.src ? <img src={props.src} alt="" draggable={false} /> : <Glyph size={16} stroke={STROKE} class={props.spin ? 'spin' : undefined} aria-hidden="true" />}
    </span>
  );
}

/**
 * Слои: строка — миниатюра того, что видно, имя и глаз. Слой, в котором работают, раскрыт (LayerCard). Генерация нового
 * слоя — строкой сверху, пока слой не появится. Shift-щелчок — слой в выделение; два и больше — «Объединить». Заплатки
 * фона — в карточке своего слоя, внизу — фон
 */
function LayersPanel(props: {
  doc: DocDto;
  objects: ObjectDto[];
  patches: PatchDto[];
  jobs: JobDto[];
  active: string | null;
  /** Слои в выделении: Shift-щелчком в списке */
  picked: Set<string>;
  /** Версия, маску которой правят */
  maskLayer: string | null;
  canDirect: boolean;
  variants: number;
  steps: number;
  onSelect: (o: ObjectDto, add: boolean) => void;
  onHover: (o: ObjectDto | null) => void;
  onRename: (o: ObjectDto, name: string) => void;
  onHidden: (o: ObjectDto, hidden: boolean) => void;
  onCurrent: (o: ObjectDto, patch: string | null) => void;
  onMask: (patch: PatchDto) => void;
  onMore: (patch: PatchDto, change?: RedoChange) => void;
  onExpand: (patch: PatchDto) => void;
  onFill: (o: ObjectDto) => void;
  onDeleteVersion: (patch: PatchDto) => void;
  onMergeDown: (o: ObjectDto) => void;
  onDelete: (o: ObjectDto) => void;
  onMerge: () => void;
  onJob: (job: JobDto, action: JobAction) => void;
  onShowJob: (job: JobDto) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  /** Скрыть просили у слоя-копии, под которым нет фона: сначала спросить */
  const [asking, setAsking] = useState<string | null>(null);
  const patches = new Map(props.patches.map((p) => [p.id, p]));
  const ids = new Set(props.objects.map((o) => o.id));
  // Заплатка фона — в карточке своего слоя; осталась без него — строкой
  const fills = new Map(props.objects.flatMap((o) => (o.kind === 'fill' && o.under && ids.has(o.under) ? [[o.under, o] as const] : [])));
  const rows = props.objects.filter((o) => !(o.kind === 'fill' && o.under && ids.has(o.under)));
  const rowIds = new Set(rows.map((o) => o.id));
  const children = new Map<string | undefined, ObjectDto[]>();
  for (const o of [...rows].reverse()) {
    const parent = o.parent && rowIds.has(o.parent) ? o.parent : undefined;
    children.set(parent, [...(children.get(parent) ?? []), o]);
  }
  const thumb = (p: PatchDto | undefined) => p && `/api/history/${p.id}/thumb.png?doc=${props.doc.id}&m=${p.maskRev}`;
  // Генерации новых слоёв — пока слоя нет
  const pending = props.jobs.filter((j) => !j.object && !j.detach);
  const picked = new Set([...props.picked, ...(props.active ? [props.active] : [])]);

  const row = (o: ObjectDto, depth: number) => {
    const active = props.active === o.id;
    const busy = props.jobs.some((j) => (j.object === o.id || j.detach === o.id) && busyJob(j));
    const failed = props.jobs.some((j) => j.object === o.id && j.status === 'error');
    // Копия без фона: скрой её — под ней то же самое
    const needsFill = o.kind !== 'fill' && !o.filled && !o.current && !o.hidden;
    return (
      <Fragment key={o.id}>
        <li
          class={['layer', active ? 'active' : '', !active && props.picked.has(o.id) ? 'picked' : '', o.hidden ? 'off' : '', o.lost ? 'lost' : ''].filter(Boolean).join(' ')}
          data-layer={o.id}
          onPointerEnter={() => props.onHover(o)}
          onPointerLeave={() => props.onHover(null)}
        >
          <div
            class="layer-row"
            style={{ paddingLeft: `${6 + depth * 16}px` }}
            title={o.lost ? 'После правки слой не нашёлся: маска прежняя' : 'Работать в слое; Shift — добавить к выделению; двойной щелчок — переименовать'}
            onClick={(e) => props.onSelect(o, e.metaKey || e.ctrlKey || e.shiftKey)}
            onDblClick={() => setEditing(o.id)}
          >
            <Thumb src={thumb(patches.get(o.current ?? o.layer ?? ''))} />
            {editing === o.id ? (
              <RenameField
                value={o.name}
                onDone={(name) => {
                  setEditing(null);
                  if (name && name !== o.name) props.onRename(o, name);
                }}
              />
            ) : (
              <span class="layer-name">{o.name}</span>
            )}
            {busy && <IconLoader2 size={15} stroke={STROKE} class="spin layer-badge" aria-label="Идёт генерация" />}
            {failed && !busy && <IconAlertTriangle size={15} stroke={STROKE} class="layer-badge error" aria-label="Генерация с ошибкой" />}
            {o.filled && <IconPhoto size={14} stroke={STROKE} class="layer-badge" aria-label="Под ним дорисован фон" />}
            {!active && props.picked.has(o.id) && <IconCheck size={15} stroke={STROKE} class="layer-badge picked" aria-label="В выделении" />}
            <button
              class="layer-icon"
              title={o.hidden ? 'Показать слой' : 'Скрыть слой'}
              aria-label="Показывать слой"
              aria-pressed={!o.hidden}
              onClick={(e) => {
                e.stopPropagation();
                if (needsFill) setAsking(asking === o.id ? null : o.id);
                else props.onHidden(o, !o.hidden);
              }}
            >
              {o.hidden ? <IconEyeOff size={17} stroke={STROKE} /> : <IconEye size={17} stroke={STROKE} />}
            </button>
          </div>
          {asking === o.id && (
            <div class="layer-ask">
              Под слоем то же самое: фона нет
              <button
                onClick={() => {
                  setAsking(null);
                  props.onFill(o);
                }}
              >
                Дорисовать фон
              </button>
              <button
                onClick={() => {
                  setAsking(null);
                  props.onHidden(o, true);
                }}
              >
                Скрыть
              </button>
            </div>
          )}
          {active && <LayerCard {...props} object={o} fill={fills.get(o.id)} patchMap={patches} thumb={thumb} />}
        </li>
        {(children.get(o.id) ?? []).map((c) => row(c, depth + 1))}
      </Fragment>
    );
  };

  return (
    <section class="panel layers-panel">
      <h2>
        Слои
        <Help>
          Слой — кусок картинки со своими пикселями поверх остального. Щелчок по слою здесь или палочкой на холсте — работа в нём:
          палочка ищет только в нём, генерация ложится его версией. Версии — миниатюры под слоем: щелчок показывает версию, «+» —
          ещё варианты. ⌘J — копия выделенного новым слоем, ⌘⇧J — вырезать: под слоем дорисуется фон. Shift-щелчок — несколько
          слоёв, ⌘E их объединяет. «\» — исходник всей картинки, пока держите.
        </Help>
      </h2>
      <ol class="layers">
        {pending.map((j) => {
          const error = j.status === 'error';
          return (
            <li class={error ? 'layer pending error' : 'layer pending'} key={j.id}>
              <div class="layer-row" title="Показать, где" onClick={() => props.onShowJob(j)}>
                <Thumb icon={error ? IconAlertTriangle : IconLoader2} spin={!error} />
                <span class="layer-name">{j.prompt}</span>
                {!error && <span class="dim">{clock(Date.now() - Date.parse(j.createdAt))}</span>}
                <button
                  class="layer-icon"
                  title={error ? 'Убрать' : 'Отменить генерацию'}
                  aria-label={error ? 'Убрать' : 'Отменить генерацию'}
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onJob(j, 'discard');
                  }}
                >
                  <IconX size={16} stroke={STROKE} />
                </button>
              </div>
              {error ? (
                <div class="layer-status error">
                  <p>{j.error}</p>
                  <button class="small primary" onClick={() => props.onJob(j, j.inside ? 'more' : 'retry')}>
                    Повторить
                  </button>
                </div>
              ) : (
                <p class="layer-sub">{jobStatus(j)} · новый слой</p>
              )}
            </li>
          );
        })}
        {(children.get(undefined) ?? []).map((o) => row(o, 0))}
        <li class="layer background">
          <div class="layer-row">
            <Thumb src={`/api/doc/base/${props.doc.levels - 1}/0/0.jpg?doc=${props.doc.id}&base=${props.doc.baseState}`} />
            <span class="layer-name">Фон</span>
          </div>
        </li>
      </ol>
      {picked.size >= 2 && (
        <div class="merge-bar">
          <span>
            {picked.size} {plural(picked.size, 'слой', 'слоя', 'слоёв')}
          </span>
          <button onClick={props.onMerge} title="Одним слоем из того, что сейчас видно; версии уйдут (⌘E)">
            Объединить
          </button>
        </div>
      )}
    </section>
  );
}

/**
 * Слой, в котором работают: версии миниатюрами (исходник, генерации, идущие и с ошибкой, «+» — ещё варианты текущей),
 * задача текущей версии с директором и критиком, ход генерации, фон под слоем и действия
 */
function LayerCard(props: {
  object: ObjectDto;
  fill?: ObjectDto;
  patchMap: Map<string, PatchDto>;
  thumb: (p: PatchDto | undefined) => string | undefined;
  jobs: JobDto[];
  maskLayer: string | null;
  canDirect: boolean;
  variants: number;
  steps: number;
  onCurrent: (o: ObjectDto, patch: string | null) => void;
  onMask: (patch: PatchDto) => void;
  onMore: (patch: PatchDto, change?: RedoChange) => void;
  onExpand: (patch: PatchDto) => void;
  onFill: (o: ObjectDto) => void;
  onDeleteVersion: (patch: PatchDto) => void;
  onMergeDown: (o: ObjectDto) => void;
  onDelete: (o: ObjectDto) => void;
  onJob: (job: JobDto, action: JobAction) => void;
}) {
  const { object: o, fill } = props;
  const [redoing, setRedoing] = useState(false);
  const [menu, setMenu] = useState(false);
  const current = o.current ? props.patchMap.get(o.current) : undefined;
  const jobs = props.jobs.filter((j) => j.object === o.id && !j.detach);
  const fillJobs = props.jobs.filter((j) => j.detach === o.id);
  // Что про вариант знает задача, пока она есть: правка почти не случилась
  const weak = new Set(props.jobs.flatMap((j) => j.variants.flatMap((v) => (v.patch && v.insideChangedPct !== undefined && v.insideChangedPct < 2 ? [v.patch] : []))));
  const count = (director: boolean) => (director ? props.steps : props.variants);
  const tile = (key: string, label: string, p: PatchDto | undefined, on: boolean, title: string, pick: () => void) => (
    <button key={key} class={['vtile', on ? 'on' : '', p && weak.has(p.id) ? 'weak' : ''].filter(Boolean).join(' ')} title={title} aria-pressed={on} onClick={pick}>
      {p ? (
        <>
          <img src={props.thumb(p)} alt="" draggable={false} />
          <span class="vtile-n">{label}</span>
        </>
      ) : (
        <span>{label}</span>
      )}
    </button>
  );
  const spinners = (js: JobDto[]) =>
    js.flatMap((j) =>
      Array.from({ length: runningTiles(j) }, (_, i) => (
        <span key={`${j.id}:${i}`} class="vtile wait" title={jobStatus(j)}>
          <IconLoader2 size={16} stroke={STROKE} class="spin" aria-hidden="true" />
        </span>
      )),
    );

  return (
    <div class="layer-card">
      <div class="version-strip">
        {tile('src', 'исх', o.layer ? props.patchMap.get(o.layer) : undefined, !o.current, o.layer ? 'Исходник слоя: копия того, что было видно' : 'Исходник: то, что под слоем', () => props.onCurrent(o, null))}
        {o.versions.map((id, i) => {
          const p = props.patchMap.get(id);
          return tile(id, String(i + 1), p, o.current === id, p?.prompt ?? '', () => props.onCurrent(o, id));
        })}
        {spinners(jobs)}
        {jobs
          .filter((j) => j.status === 'error')
          .map((j) => (
            <span key={j.id} class="vtile failed" title={j.error}>
              <IconAlertTriangle size={16} stroke={STROKE} aria-hidden="true" />
            </span>
          ))}
        {current && !jobs.some(busyJob) && (
          <button
            class="vtile add"
            title={current.directed !== undefined ? `Ещё ${countText(true, count(true))} от текущей версии` : `Ещё ${countText(false, count(false))} с той же задачей`}
            aria-label="Ещё варианты"
            onClick={() => props.onMore(current)}
          >
            <IconPlus size={16} stroke={STROKE} />
          </button>
        )}
      </div>

      {current && !redoing && (
        <div class="layer-task">
          <p title={current.prompt}>{current.prompt}</p>
          <button class="icon" title="Поправить задачу и сгенерировать ещё" aria-label="Поправить задачу" onClick={() => setRedoing(true)}>
            <IconPencil size={15} stroke={STROKE} />
          </button>
        </div>
      )}
      {current?.directed && !redoing && <Note label="Директор" text={current.directed} />}
      {current?.critique && !redoing && <Note label={current.critique.done ? 'Критик: готово' : 'Критик'} text={current.critique.text} />}
      {redoing && current && (
        <RedoForm
          prompt={current.prompt}
          hide={current.hide ?? false}
          director={current.directed !== undefined}
          canDirect={props.canDirect}
          variants={props.variants}
          steps={props.steps}
          onCancel={() => setRedoing(false)}
          onSubmit={(change) => {
            setRedoing(false);
            props.onMore(current, change);
          }}
        />
      )}
      {current && weak.has(current.id) && (
        <p class="job-warning">
          Модель почти ничего не изменила
          <Help>Опишите, что должно получиться, а не что исправить, или выделите область поменьше.</Help>
        </p>
      )}

      {[...jobs, ...fillJobs].filter(busyJob).map((j) => (
        <div class="layer-status" key={j.id}>
          <span>
            {j.detach ? 'Фон: ' : ''}
            {jobStatus(j)}, {clock(Date.now() - Date.parse(j.createdAt))}
          </span>
          {j.chain && (
            <button class="small" title="Готовые шаги останутся версиями" onClick={() => props.onJob(j, 'stop')}>
              Остановить
            </button>
          )}
          <button class="small" title="Готовые варианты останутся версиями" onClick={() => props.onJob(j, 'discard')}>
            Отменить
          </button>
        </div>
      ))}
      {[...jobs, ...fillJobs]
        .filter((j) => j.status === 'error')
        .map((j) => (
          <div class="layer-status error" key={j.id}>
            <p>{j.error}</p>
            <button class="small primary" onClick={() => props.onJob(j, j.inside ? 'more' : 'retry')}>
              Повторить
            </button>
            <button class="small" onClick={() => props.onJob(j, 'discard')}>
              Убрать
            </button>
          </div>
        ))}

      {(fill || fillJobs.some(busyJob)) && (
        <div class="version-strip fill-strip">
          <span class="strip-label">Фон</span>
          {fill?.versions.map((id, i) => {
            const p = props.patchMap.get(id);
            return tile(id, String(i + 1), p, fill.current === id, 'Вариант фона под слоем', () => props.onCurrent(fill, id));
          })}
          {spinners(fillJobs)}
          {fill && !fillJobs.some(busyJob) && (
            <button class="vtile add" title="Ещё варианты фона" aria-label="Ещё варианты фона" onClick={() => props.onFill(o)}>
              <IconPlus size={16} stroke={STROKE} />
            </button>
          )}
        </div>
      )}

      <div class="layer-tools">
        <button
          class={current && props.maskLayer === current.id ? 'icon active' : 'icon'}
          title={current ? 'Править маску версии' : 'У исходника маски нет'}
          aria-label="Править маску версии"
          disabled={!current || o.hidden}
          onClick={() => current && props.onMask(current)}
        >
          <IconMask size={17} stroke={STROKE} />
        </button>
        {!fill && o.kind !== 'fill' && (
          <button class="icon" title="Дорисовать фон под слоем: его можно будет сдвигать и скрывать" aria-label="Дорисовать фон под слоем" disabled={fillJobs.some(busyJob)} onClick={() => props.onFill(o)}>
            <IconPhoto size={17} stroke={STROKE} />
          </button>
        )}
        <button class="icon" title="Влить в фон" aria-label="Влить в фон" disabled={o.hidden} onClick={() => props.onMergeDown(o)}>
          <IconArrowBarToDown size={17} stroke={STROKE} />
        </button>
        <button class="icon" title={o.filled ? 'Убрать с холста' : 'Удалить слой'} aria-label="Удалить слой" onClick={() => props.onDelete(o)}>
          <IconTrash size={17} stroke={STROKE} />
        </button>
        {current && (
          <span class="menu-anchor">
            <button class="icon" title="Ещё" aria-label="Ещё" aria-expanded={menu} onClick={() => setMenu(!menu)}>
              <IconDots size={17} stroke={STROKE} />
            </button>
            {menu && (
              <>
                <div class="click-catcher" onClick={() => setMenu(false)} />
                <ul class="layer-menu" role="menu" onClick={() => setMenu(false)}>
                  <li role="menuitem" onClick={() => props.onExpand(current)}>
                    Расширить по правке
                  </li>
                  <li role="menuitem" class="danger" onClick={() => props.onDeleteVersion(current)}>
                    Удалить версию
                  </li>
                </ul>
              </>
            )}
          </span>
        )}
      </div>
    </div>
  );
}

/** Поле имени: текст сразу выделен, Enter или щелчок мимо — сохранить, Esc — передумать */
function RenameField(props: { value: string; onDone: (name: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (name: string | null) => {
    if (done.current) return;
    done.current = true;
    props.onDone(name?.trim() || null);
  };
  return (
    <input
      ref={ref}
      class="object-name"
      defaultValue={props.value}
      aria-label="Имя объекта"
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(e.currentTarget.value);
        } else if (e.key === 'Escape') {
          e.stopPropagation();
          finish(null);
        }
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
    />
  );
}

/** Флажок «скрыть от модели то, что под маской» */
function HideOption(props: { checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <span class="check">
      <label>
        <input type="checkbox" checked={props.checked} onChange={(e) => props.onChange(e.currentTarget.checked)} />
        Скрыть от модели, что под маской
      </label>
      <Help>Модель получит кусок, где область залита серым, и нарисует её с нуля, не держась за то, что там было. Подходит, чтобы заменить предмет, а не поправить его.</Help>
    </span>
  );
}

/** Флажок директора: ChatGPT расписывает задачу перед генерацией */
function DirectorOption(props: { checked: boolean; disabled: boolean; onChange: (checked: boolean) => void }) {
  return (
    <span class="check">
      <label title={props.disabled ? 'Директор работает через Codex, а он не найден' : undefined}>
        <input type="checkbox" checked={props.checked} disabled={props.disabled} onChange={(e) => props.onChange(e.currentTarget.checked)} />
        Директор
      </label>
      <Help>
        Перед генерацией ChatGPT смотрит на кусок, набросок, задачу и стиль документа и расписывает задачу для модели подробно. Модель
        получает оба текста; ваша задача остаётся как есть, текст директора — в карточке под ней. Правка идёт шагами: после каждого
        критик (тот же ChatGPT) смотрит результат и говорит, что исправить, и следующий шаг исправляет это. Шаги кончаются, когда
        критик доволен или их число вышло; каждый шаг остаётся вариантом. Директор и критик идут по подписке ChatGPT через Codex,
        каждый добавляет около минуты.
      </Help>
    </span>
  );
}

/** Текст директора или замечания критика: две строки, по щелчку — целиком */
function Note(props: { label: string; text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <p
      class={open ? 'directed open' : 'directed'}
      title={open ? undefined : 'Показать целиком'}
      onClick={(e) => {
        e.stopPropagation();
        setOpen((v) => !v);
      }}
    >
      <span class="directed-label">{props.label}</span> {props.text}
    </p>
  );
}

/** Плашка «что уже есть в форме» с крестиком, который это убирает */
function Chip(props: { icon: Icon; label: string; clear: string; onClear: () => void }) {
  const ChipIcon = props.icon;
  return (
    <span class="chip">
      <ChipIcon size={14} stroke={STROKE} aria-hidden="true" />
      {props.label}
      <button class="chip-clear" title={props.clear} aria-label={props.clear} onClick={props.onClear}>
        <IconX size={12} stroke={2.25} />
      </button>
    </span>
  );
}

/**
 * Значок «?» рядом с элементом: пояснение открывается по щелчку и закрывается щелчком мимо или Esc.
 * Окно — в body и fixed: его не обрезает прокрутка боковой панели, и transform баннера не сдвигает.
 */
function Help(props: { children: ComponentChildren }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const root = useRef<HTMLSpanElement>(null);
  const pop = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => {
      const target = e.target as Node;
      if (!root.current?.contains(target) && !pop.current?.contains(target)) setOpen(false);
    };
    // Esc закрывает подсказку и дальше не идёт: иначе он сбросил бы выделение
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
    };
    const scroll = () => setOpen(false);
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', esc, true);
    window.addEventListener('scroll', scroll, true);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', esc, true);
      window.removeEventListener('scroll', scroll, true);
    };
  }, [open]);
  // Под значком, но в пределах окна
  useLayoutEffect(() => {
    if (!open || !root.current || !pop.current) return;
    const anchor = root.current.getBoundingClientRect();
    const { width, height } = pop.current.getBoundingClientRect();
    const left = Math.min(Math.max(8, anchor.left + anchor.width / 2 - width / 2), window.innerWidth - width - 8);
    const below = anchor.bottom + 6;
    setPos({ left, top: below + height > window.innerHeight - 8 ? Math.max(8, anchor.top - height - 6) : below });
  }, [open]);
  return (
    <span class="help" ref={root}>
      <button
        type="button"
        class={open ? 'help-toggle active' : 'help-toggle'}
        aria-label="Подсказка"
        aria-expanded={open}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setPos(null);
          setOpen((v) => !v);
        }}
      >
        <IconHelpCircle size={15} stroke={STROKE} />
      </button>
      {open &&
        createPortal(
          <span ref={pop} class="help-pop" role="tooltip" style={pos ? { left: `${pos.left}px`, top: `${pos.top}px` } : { visibility: 'hidden' }}>
            {props.children}
          </span>,
          document.body,
        )}
    </span>
  );
}

/** Повтор правки с поправкой: задача, скрытие под маской и директор; ⌘↵ — сгенерировать, Esc — передумать */
function RedoForm(props: {
  prompt: string;
  hide: boolean;
  director: boolean;
  canDirect: boolean;
  variants: number;
  steps: number;
  onSubmit: (change: RedoChange) => void;
  onCancel: () => void;
}) {
  const [prompt, setPrompt] = useState(props.prompt);
  const [hide, setHide] = useState(props.hide);
  const [director, setDirector] = useState(props.director);
  const submit = () => {
    if (prompt.trim()) props.onSubmit({ prompt: prompt.trim(), hide, director: director && props.canDirect });
  };
  return (
    <form
      class="redo"
      onClick={(e) => e.stopPropagation()}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onKeyDown={(e) => {
        // Свои ⌘↵ и Esc: общие сочетания отправили бы форму новой правки и сбросили выделение
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          submit();
        } else if (e.key === 'Escape') {
          e.stopPropagation();
          props.onCancel();
        }
      }}
    >
      <textarea rows={3} autoFocus value={prompt} aria-label="Поправленная задача" onInput={(e) => setPrompt(e.currentTarget.value)} />
      <div class="checks">
        <HideOption checked={hide} onChange={setHide} />
        <DirectorOption checked={director && props.canDirect} disabled={!props.canDirect} onChange={setDirector} />
      </div>
      <div class="row">
        <button type="submit" class="primary" disabled={!prompt.trim()} title="⌘↵">
          {director && props.canDirect ? generateText(true, props.steps) : generateText(false, props.variants)}
        </button>
        <button type="button" onClick={props.onCancel}>
          Отмена
        </button>
      </div>
    </form>
  );
}

/** Хватает ли куску разрешения ответа: мало — размоется, много — лишнее ожидание без новых деталей */
function SizeHint(props: { advice: SizeAdvice; auto: boolean; sizes: string[]; onSize: (size: SizeChoice) => void }) {
  const { frame, imageSize, output, scale, enough } = props.advice;
  const piece = `${frame.rect.width}×${frame.rect.height}`;
  const label = props.auto ? `авто (${imageSize})` : imageSize;
  const slow = (size: string) => (size === '4K' ? ', но идёт 4–5 минут' : '');
  const pick = (size: string) => (
    <button class="small" onClick={() => props.onSize(size as SizeChoice)}>
      Поставить {size}
    </button>
  );
  if (props.advice.tooSmall) {
    const better = props.sizes.indexOf(enough) > props.sizes.indexOf(imageSize) ? enough : null;
    return (
      <div class="size-hint warn">
        <p>
          Мало разрешения: детали упадут в {scale.toFixed(1).replace('.', ',')} раза
          <Help>
            Кусок с контекстом {piece}, а {label} вернёт {output.width}×{output.height}.{' '}
            {!better
              ? 'Это наибольшее разрешение модели: выделите область поменьше или правьте её по частям.'
              : props.advice.beyond
                ? `Даже ${better} будет мало${slow(better)}: лучше выделить область поменьше.`
                : `Хватит ${better}${slow(better)}.`}
          </Help>
        </p>
        {better && pick(better)}
      </div>
    );
  }
  if (props.advice.tooBig) {
    return (
      <div class="size-hint warn">
        <p>
          С запасом: хватит {enough}
          <Help>
            Кусок {piece}. {label} не добавит деталей — ответ всё равно уменьшится до размера куска{imageSize === '4K' ? ', а ждать его 4–5 минут' : ''}.
          </Help>
        </p>
        {pick(enough)}
      </div>
    );
  }
  return (
    <p class="hint size-hint" title="Кусок с контекстом → ответ модели">
      {piece} → {output.width}×{output.height}, {label}
    </p>
  );
}

function SettingsDialog(props: {
  hasKey: boolean;
  codex: string | null;
  onClose: () => void;
  onSaved: (text: string) => void;
  onError: (err: unknown) => void;
}) {
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const mac = navigator.userAgent.includes('Mac');
  const run = async (action: () => Promise<unknown>, text: string) => {
    setSaving(true);
    try {
      await action();
      setValue('');
      props.onSaved(text);
    } catch (err) {
      props.onError(err);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div class="modal-backdrop" onClick={props.onClose}>
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="settings-title">Настройки</h2>
        <h3>Ключ laozhang.ai</h3>
        <p>
          {props.hasKey ? 'Ключ сохранён.' : 'Нужен для Nano Banana. Он есть в личном кабинете laozhang.ai.'}
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => post('/api/settings/key', { key: value }), 'Ключ сохранён');
          }}
        >
          <input
            type="password"
            autoFocus
            autoComplete="off"
            spellcheck={false}
            placeholder={props.hasKey ? 'Новый ключ' : 'Ключ'}
            value={value}
            onInput={(e) => setValue(e.currentTarget.value)}
          />
          <p class="hint">{mac ? 'Хранится в Связке ключей macOS' : 'Хранится на этом компьютере зашифрованным'} и уходит только в laozhang.ai.</p>
          <div class="row">
            <button class="primary" type="submit" disabled={!value.trim() || saving}>
              Сохранить ключ
            </button>
            <button type="button" onClick={props.onClose}>
              Закрыть
            </button>
            {props.hasKey && (
              <button
                type="button"
                class="danger"
                disabled={saving}
                onClick={() => void run(() => post('/api/settings/key/clear'), 'Ключ удалён')}
              >
                Удалить ключ
              </button>
            )}
          </div>
        </form>
        <h3>ChatGPT Images по подписке</h3>
        {props.codex ? (
          <>
            <p>Картинки и директор идут через Codex по подписке ChatGPT, ключ не нужен.</p>
            <p class="hint">
              Codex: <code>{props.codex}</code>. Если пишет, что вход не выполнен, войдите в Codex в приложении ChatGPT.
            </p>
          </>
        ) : (
          <p>Не найден Codex. Установите приложение ChatGPT (Codex в нём есть) или Codex CLI и войдите в ChatGPT.</p>
        )}
      </div>
    </div>
  );
}

function NewCanvasForm(props: { onError: (err: unknown) => void; onCreated?: () => void; extra?: ComponentChildren }) {
  const [width, setWidth] = useState(3840);
  const [height, setHeight] = useState(2160);
  const [color, setColor] = useState('#ffffff');
  const [creating, setCreating] = useState(false);
  // Пресет узнаётся по размеру в любой ориентации: «Повернуть» его не сбрасывает
  const preset = CANVAS_PRESETS.find((p) => (p.width === width && p.height === height) || (p.width === height && p.height === width));
  const valid = [width, height].every((v) => Number.isInteger(v) && v >= 16 && v <= 30000);
  const megapixels = (width * height) / 1e6;
  return (
    <form
      class="new-canvas"
      onSubmit={(e) => {
        e.preventDefault();
        setCreating(true);
        post<{ opened: boolean }>('/api/doc/new', { width, height, color, dpi: preset?.dpi })
          .then(({ opened }) => opened && props.onCreated?.())
          .catch(props.onError)
          .finally(() => setCreating(false));
      }}
    >
      <div class="presets" role="radiogroup" aria-label="Размер">
        {CANVAS_PRESETS.map((p) => {
          const scale = 22 / Math.max(p.width, p.height);
          const turned = preset === p && p.width !== width;
          const w = turned ? p.height : p.width;
          const h = turned ? p.width : p.height;
          return (
            <button
              type="button"
              role="radio"
              aria-checked={preset === p}
              class={preset === p ? 'preset active' : 'preset'}
              onClick={() => {
                setWidth(p.width);
                setHeight(p.height);
              }}
            >
              <span class="preset-shape" aria-hidden="true">
                <span style={{ width: `${Math.max(4, Math.round(w * scale))}px`, height: `${Math.max(4, Math.round(h * scale))}px` }} />
              </span>
              <span class="preset-name">{p.name}</span>
              <span class="preset-size">
                {w} × {h}
                {p.dpi && `, ${p.dpi} dpi`}
              </span>
            </button>
          );
        })}
      </div>
      <div class="size-row">
        <label>
          Ширина
          <input type="number" min={16} max={30000} value={width} onInput={(e) => setWidth(Number(e.currentTarget.value))} />
        </label>
        <button
          type="button"
          class="icon swap"
          title="Повернуть: поменять ширину и высоту"
          aria-label="Поменять ширину и высоту"
          onClick={() => {
            setWidth(height);
            setHeight(width);
          }}
        >
          <IconArrowsExchange size={16} stroke={STROKE} />
        </button>
        <label>
          Высота
          <input type="number" min={16} max={30000} value={height} onInput={(e) => setHeight(Number(e.currentTarget.value))} />
        </label>
        <label>
          Фон
          <input type="color" value={color} onInput={(e) => setColor(e.currentTarget.value)} />
        </label>
      </div>
      <p class="hint">{valid ? `${megapixels.toFixed(1).replace('.', ',')} Мп${preset?.dpi ? `, для печати ${preset.dpi} dpi` : ''}` : 'Каждая сторона — от 16 до 30 000 пикселей'}</p>
      <div class="row">
        <button type="submit" class="primary" disabled={!valid || creating}>
          Создать холст
        </button>
        {props.extra}
      </div>
    </form>
  );
}

function StartScreen(props: { recent: RecentDto[]; onOpen: () => void; onOpenRecent: (id: string) => void; onError: (err: unknown) => void }) {
  return (
    <div class="start">
      <div class="start-sheet">
        <section class="start-open">
          <header class="start-head">
            <div>
              <h1>Откройте картинку</h1>
              <p class="hint">PNG, JPEG, WebP, TIFF или проект .caaa</p>
            </div>
            <button class="primary" onClick={props.onOpen}>
              Открыть…
            </button>
          </header>
          <h2>Недавние</h2>
          {props.recent.length ? (
            <ul class="recent">
              {props.recent.map((r) => (
                <li key={r.id}>
                  <button class="recent-item" title={r.path} onClick={() => props.onOpenRecent(r.id)}>
                    <span class="recent-thumb">
                      <img src={`/api/recent/${r.id}/thumb.jpg?v=${encodeURIComponent(r.openedAt)}`} alt="" loading="lazy" />
                    </span>
                    <span class="recent-name">{r.name}</span>
                    <span class="recent-meta">
                      {r.width}×{r.height} · {folder(r.path)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p class="hint">Пока пусто</p>
          )}
        </section>
        <section class="start-new">
          <h1>Или новый холст</h1>
          <NewCanvasForm onError={props.onError} />
        </section>
      </div>
    </div>
  );
}
