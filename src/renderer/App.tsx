import {
  IconArrowBackUp,
  IconArrowForwardUp,
  IconArrowsExchange,
  IconArrowsMove,
  IconBrush,
  IconCubePlus,
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
  IconPalette,
  IconPencil,
  IconPhoto,
  IconPhotoPlus,
  IconScissors,
  IconPlus,
  IconScribble,
  IconSquare,
  IconStack2,
  IconLoader2,
  IconAlertTriangle,
  IconArrowBarToDown,
  IconArrowsMaximize,
  IconBucketDroplet,
  IconChevronDown,
  IconChevronRight,
  IconFolder,
  IconFolderOpen,
  IconFolderPlus,
  IconDots,
  IconAdjustmentsHorizontal,
  IconLock,
  IconPlayerStop,
  IconRefresh,
  IconStackPop,
  IconZoomIn,
  IconZoomOut,
  IconSparkles,
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
  canvasPresets,
  COMMAND_EVENT,
  GEMINI_SERVICE_NAMES,
  GEMINI_SERVICES,
  MAX_REFERENCES,
  OUTSIDE_LAYER,
  shapesBBox,
  type AppCommand,
  type DocDto,
  type GeminiService,
  type GroupDto,
  type JobDto,
  type MaskEditResult,
  type MaskResult,
  type MaskShape,
  type ModelChoice,
  type ModelOutputsDto,
  type ObjectDto,
  type ObjectMaskRequest,
  type PatchDto,
  type PickResult,
  type RecentDto,
  type RedoChange,
  type SegmentPoint,
  type SizeChoice,
  type SketchStroke,
  type StateDto,
} from '../shared/api.ts';
import { getState, post, prefs, savePref, subscribe, upload, uploadReference } from './api.ts';
import { CanvasView, type MaskEditView, type MaskRef, type Movable, type PeekView, type PickEvent, type SelectOp, type Tool } from './viewer.ts';
import { decimal, L, lang, plural, type Lang, type LangChoice } from '../shared/i18n.ts';

/** Названия языков — каждый на себе */
const LANG_NAMES: Record<Lang, string> = { en: 'English', ru: 'Русский' };

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

/** Настройка, которая помнится между запусками (её хранит сервер); valid отсеивает то, чего уже нет, — тогда по умолчанию */
function usePref<T>(key: string, initial: T, valid?: (value: unknown) => boolean): [T, (value: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    const saved = prefs[key];
    return saved === undefined || saved === null || (valid && !valid(saved)) ? initial : (saved as T);
  });
  useEffect(() => {
    if (JSON.stringify(prefs[key] ?? initial) !== JSON.stringify(value)) savePref(key, value);
  }, [value]);
  return [value, setValue];
}

/** Подписи уровней объекта от мелкого к крупному */
function levelNames(n: number): string[] {
  return n >= 3 ? [L('Деталь', 'Detail'), L('Часть', 'Part'), L('Целое', 'Whole')].concat(Array.from({ length: n - 3 }, (_, i) => `${i + 4}`)) : [L('Часть', 'Part'), L('Целое', 'Whole')].slice(2 - n);
}

/** Сохранённый объект как фигура выделения */
function objectShape(o: ObjectDto): MaskRef {
  return { kind: 'mask', id: `obj:${o.id}`, ...o.rect, rev: o.rev };
}

/** Сколько сгенерировать: варианты разом или, с директором, шаги с критиком */
function countText(director: boolean, n: number): string {
  return `${n} ${director ? plural(n, ['шаг', 'шага', 'шагов'], ['step', 'steps']) : plural(n, ['вариант', 'варианта', 'вариантов'], ['variant', 'variants'])}`;
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
    // Маска для правки — уже прозрачность версии: кисть кладёт мазки прямо в неё, растушёвки поверх нет
    feather: 0,
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
      if (!out) throw new Error(L(`Модель не умеет ${aspectRatio} в ${imageSize}`, `The model cannot do ${aspectRatio} at ${imageSize}`));
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
  sketch: IconScribble,
};

/** name — на панели настроек, label — во всплывающей подсказке */
const TOOLS: { id: Tool; name: string; label: string; key: string }[] = [
  { id: 'object', name: L('Палочка', 'Wand'), label: L('Палочка: объект под щелчком', 'Wand: object under the click'), key: 'W' },
  { id: 'move', name: L('Сдвинуть', 'Move'), label: L('Сдвинуть слой', 'Move layer'), key: 'V' },
  { id: 'rect', name: L('Прямоугольник', 'Rectangle'), label: L('Прямоугольник', 'Rectangle'), key: 'R' },
  { id: 'lasso', name: L('Лассо', 'Lasso'), label: L('Лассо', 'Lasso'), key: 'L' },
  { id: 'brush', name: L('Кисть', 'Brush'), label: L('Кисть', 'Brush'), key: 'B' },
  { id: 'sketch', name: L('Набросок', 'Sketch'), label: L('Набросок для модели, Alt стирает', 'Sketch for the model, Alt erases'), key: 'S' },
  { id: 'hand', name: L('Рука', 'Hand'), label: L('Рука (или зажать пробел)', 'Hand (or hold Space)'), key: 'H' },
];

/** Инструменты выделения: у них режим «Новое / Добавить / Вычесть» и край */
const SELECTING: Tool[] = ['object', 'rect', 'lasso', 'brush'];

/** Цвета наброска под рукой; любой другой — из палитры */
const SKETCH_COLORS = ['#ff3b30', '#1e88ff', '#22b14c', '#111111', '#ffffff'];

/** label — в списке моделей, short — в сводке над кнопкой генерации, note — подпись в списке (у Nano Banana перед ней — чей ключ) */
const MODELS: { id: ModelChoice; label: string; short: string; note?: string }[] = [
  { id: 'flash', label: 'Nano Banana 2.1', short: 'Banana 2.1' },
  { id: 'pro', label: 'Nano Banana Pro', short: 'Banana Pro', note: L('дороже', 'pricier') },
  { id: 'chatgpt', label: 'ChatGPT Images', short: 'ChatGPT', note: L('подписка ChatGPT', 'ChatGPT subscription') },
];
const modelInfo = (id: ModelChoice) => MODELS.find((m) => m.id === id) ?? MODELS[0]!;

const SIZES: SizeChoice[] = ['auto', '1K', '2K', '4K'];

/** Сколько вариантов или шагов можно выбрать в форме */
const COUNTS = [1, 2, 3, 4];
const isCount = (v: unknown) => COUNTS.includes(v as number);

/** Nano Banana идёт по ключу (Gemini API или laozhang.ai), ChatGPT — по подписке через Codex, ключ ему не нужен */
const needsKey = (model: ModelChoice) => model !== 'chatgpt';
const keyName = (service: GeminiService) => L(`ключ ${GEMINI_SERVICE_NAMES[service]}`, `${GEMINI_SERVICE_NAMES[service]} key`);
const keyNeeded = (service: GeminiService) => L(`нужен ключ ${GEMINI_SERVICE_NAMES[service]}`, `${GEMINI_SERVICE_NAMES[service]} key needed`);

/** Что сейчас с задачей: директор расписывает её до генерации */
function jobStatus(job: JobDto): string {
  if (job.directing) return L('Директор думает', 'Director is thinking');
  if (job.reviewing) return L('Критик смотрит', 'Critic is reviewing');
  if (job.chain?.step) return L(`Шаг ${job.chain.step} из ${job.chain.steps}`, `Step ${job.chain.step} of ${job.chain.steps}`);
  if (masksOnly(job)) return L('Маска по объекту', 'Object mask');
  return STATUS[job.status];
}

/** Варианты готовы, модель рисует им маски по объекту */
function masksOnly(job: JobDto): boolean {
  return !job.chain && job.variants.some((v) => v.masking) && !job.variants.some((v) => v.status === 'running');
}

const STATUS: Record<JobDto['status'], string> = {
  queued: L('Ждёт очереди', 'Queued'),
  preparing: L('Готовлю кусок', 'Preparing crop'),
  running: L('Генерация', 'Generating'),
  done: L('Готово', 'Done'),
  error: L('Ошибка', 'Error'),
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
  const [director, setDirector] = usePref('director', false);
  /** Каждому новому варианту модель сразу рисует маску по объекту */
  const [autoMask, setAutoMask] = usePref('object-mask', false);
  const [model, setModel] = usePref<ModelChoice>('model', 'flash', (v) => MODELS.some((m) => m.id === v));
  const [size, setSize] = usePref<SizeChoice>('size', 'auto', (v) => SIZES.includes(v as SizeChoice));
  const [variants, setVariants] = usePref('variants', 2, isCount);
  /** Сколько шагов с критиком, когда включён директор */
  const [steps, setSteps] = usePref('steps', 3, isCount);
  /** Слой, маску видимой версии которого сейчас правят (миниатюра маски в «Слоях»); всегда тот, в котором работают */
  const [maskLayer, setMaskLayer] = useState<string | null>(null);
  /** При правке маски кисть и фигуры возвращают часть версии (add) или скрывают её (sub); Alt — наоборот */
  const [maskOp, setMaskOp] = useState<'add' | 'sub'>('sub');
  /** Слой, в котором работают: палочка ищет только в нём, генерация ложится его версией; нет — новым слоем */
  const [active, setActive] = useState<string | null>(null);
  /** Группа, выбранная в «Слоях»: её слои в выделении, новый слой ляжет сверху в неё */
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const [zoom, setZoom] = useState(0);
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'settings' | 'new' | 'style' | null>(null);
  const [zoomMenu, setZoomMenu] = useState(false);
  const [refs, setRefs] = useState<string[]>([]);
  /** Объект, на который навели в списке объектов */
  const [litObject, setLitObject] = useState<string | null>(null);
  /** Держат «\»: на холсте исходник */
  const [comparing, setComparing] = useState(false);
  /** Генерация нового слоя, выбранная в «Слоях»: её ход и ошибка — в ленте под холстом */
  const [activeJob, setActiveJob] = useState<string | null>(null);
  /** Генерация с ошибкой, выбранная плиткой в ленте слоя: её ошибка и «Повторить» — в ленте */
  const [errorJob, setErrorJob] = useState<string | null>(null);
  /**
   * Поправка задачи версии: поле правки — для неё, со своими «С нуля» и директором; черновик новой правки ждёт в draft.
   * Модель, разрешение и референсы — версии
   */
  const [redoing, setRedoing] = useState<{ patch: string; draft: string; hide: boolean; director: boolean } | null>(null);
  /** Лента версий под холстом свёрнута в строку */
  const [bandFolded, setBandFolded] = usePref('band-folded', false);
  /** Холст приближен к куску слоя (F); ещё раз — вся картинка */
  const [focused, setFocused] = useState(false);
  /** Версия, на которую навели в ленте (patch null — исходник): её видно на холсте, документ не меняется */
  const [peek, setPeek] = useState<{ object: string; patch: string | null } | null>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const [, setTick] = useState(0);

  const stageRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const refRef = useRef<HTMLInputElement>(null);
  const viewRef = useRef<CanvasView | null>(null);
  const refreshSeq = useRef(0);
  const onShape = useRef<(shape: MaskShape, op: SelectOp) => void>(() => undefined);
  const onSketch = useRef<(stroke: SketchStroke) => void>(() => undefined);
  const onPick = useRef<(event: PickEvent) => void>(() => undefined);
  const onMove = useRef<(id: string, dx: number, dy: number) => Promise<number>>(() => Promise.reject(new Error(L('Нет документа', 'No document'))));
  /** Как найдена каждая фигура «Палочки» в выделении */
  const picks = useRef(new WeakMap<MaskShape, Pick>());
  /** Выделение на этот миг: щелчки «Палочкой» идут по очереди и не ждут перерисовки */
  const selectionRef = useRef<MaskShape[]>([]);
  const pickChain = useRef<Promise<unknown>>(Promise.resolve());
  /** В каком порядке в форму новой правки ложились фигуры выделения и штрихи наброска — ⌘Z убирает последнее */
  const formOrder = useRef<('shape' | 'sketch')[]>([]);
  const onMaskShape = useRef<(view: MaskEditView, shape: MaskShape) => Promise<MaskEditResult>>(() => Promise.reject(new Error(L('Нет правки маски', 'No mask edit'))));
  const toastTimer = useRef<number | undefined>(undefined);

  const doc = state?.doc ?? null;
  const jobs = state?.jobs ?? [];
  const layers = state?.history ?? [];
  const objects = state?.objects ?? [];
  const groups = state?.groups ?? [];
  const segment = state?.segment;
  const segmentReady = segment?.status === 'ready';
  selectionRef.current = selection;
  const maskObj = maskLayer ? objects.find((o) => o.id === maskLayer && o.kind !== 'fill') : undefined;
  /** Версия, маску которой правят: что сейчас видно от слоя — другая версия становится текущей, и правится её маска */
  const editedLayer = (maskObj && layers.find((p) => p.id === (maskObj.current ?? maskObj.layer) && p.active)) || null;
  const maskEdit = editedLayer ? layerMaskEdit(editedLayer, layers) : null;
  const activeObj = active ? objects.find((o) => o.id === active) : undefined;
  const activeGrp = activeGroup ? groups.find((g) => g.id === activeGroup) : undefined;

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
    setSelection([]);
    setSketch([]);
    formOrder.current = [];
    setMaskLayer(null);
    setActive(null);
    setActiveGroup(null);
    setActiveJob(null);
    setRedoing(null);
    setPeek(null);
  }, [doc?.id]);
  // Удалённый слой — работа вне слоя; ушедшая группа — тоже
  useEffect(() => {
    if (active && state && !activeObj) setActive(null);
  }, [active, !!activeObj]);
  useEffect(() => {
    if (activeGroup && state && !activeGrp) setActiveGroup(null);
  }, [activeGroup, !!activeGrp]);
  useEffect(() => viewRef.current?.setLayer(activeObj && !maskLayer ? objectShape(activeObj) : null), [activeObj?.id, activeObj?.rev, !!maskLayer]);
  // Слой, в который вошли щелчком на холсте, виден и в списке
  useEffect(() => {
    if (active) document.querySelector(`.layers li[data-layer="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  // Другой слой — холст снова целиком, а поправка задачи чужой версии кончается
  useEffect(() => {
    setFocused(false);
    setPeek(null);
    if (redoing && !objects.some((o) => o.id === active && o.versions.includes(redoing.patch))) endRedo();
  }, [active]);
  // Ошибка, выбранная в ленте, — только у генерации этого слоя, пока она есть
  useEffect(() => {
    if (errorJob && jobs.find((j) => j.id === errorJob)?.object !== active) setErrorJob(null);
  }, [active, errorJob, state?.jobs]);
  // Выбранная генерация нового слоя: ушла — выбора нет; легла слоем — работа в нём
  const selJob = activeJob ? jobs.find((j) => j.id === activeJob) : undefined;
  /** Какой её видели последней: законченную задачу интерфейс убирает сам, и слой мог появиться вместе с её уходом */
  const lastJob = useRef<JobDto | undefined>(undefined);
  if (selJob) lastJob.current = selJob;
  useEffect(() => {
    if (!activeJob || !state) return;
    // Только что созданной задачи в состоянии может ещё не быть: ждём, пока она появится
    const seen = lastJob.current?.id === activeJob ? lastJob.current : undefined;
    const o = seen?.object ? objects.find((x) => x.id === seen.object) : undefined;
    if (o) enterLayer(o);
    else if (!selJob && seen) setActiveJob(null);
  }, [activeJob, !!selJob, selJob?.object, state?.objects]);
  // На холсте — рамки идущих генераций и генераций с ошибкой, с подписью слоя
  useEffect(() => {
    const open = jobs.filter((j) => busyJob(j) || j.status === 'error');
    const labels = new Map(
      open.map((j) => {
        const under = j.fillFor ? objects.find((x) => x.id === j.fillFor) : undefined;
        const o = objects.find((x) => x.id === j.object);
        return [j.id, under ? L(`Фон под «${short(under.name, 20)}»`, `Background under “${short(under.name, 20)}”`) : o ? short(o.name, 24) : L('Новый слой', 'New layer')];
      }),
    );
    viewRef.current?.setJobs(open, labels);
  }, [state?.jobs, state?.objects]);
  // Законченная генерация больше не нужна: её варианты — версии слоёв. Задачи с ошибкой остаются, пока их не уберут.
  // Маска по объекту, которая не вышла, — сообщением: версия осталась с маской выделения
  const discarded = useRef(new Set<string>());
  useEffect(() => {
    for (const j of jobs) {
      if (j.status !== 'done' || busyJob(j) || discarded.current.has(j.id)) continue;
      discarded.current.add(j.id);
      const failed = j.variants.find((v) => v.maskError);
      if (failed) notify(L(`Маска по объекту: ${failed.maskError}`, `Object mask: ${failed.maskError}`));
      post(`/api/jobs/${j.id}/discard`).catch(() => discarded.current.delete(j.id));
    }
  }, [state?.jobs]);
  // Маску правят только у слоя, в котором работают, пока от него что-то видно: скрытый слой или исходник слоя из генерации — нет
  useEffect(() => {
    if (maskLayer && (maskLayer !== active || !editedLayer)) setMaskLayer(null);
  }, [maskLayer, active, editedLayer?.id]);
  useEffect(() => viewRef.current?.setMaskErase(maskOp === 'sub'), [maskOp]);
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
    if (brushSnap && shape.kind === 'stroke' && tool === 'brush') {
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
          if (err instanceof Error && err.message === OUTSIDE_LAYER) notify(within ? L(`Вне слоя «${short(within.name, 24)}»`, `Outside layer “${short(within.name, 24)}”`) : L('Здесь слой: щелчок без Shift откроет его', 'There is a layer here: click without Shift to open it'), false);
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
      if (res.unchanged) notify(L(`${e.op === 'add' ? 'Это уже в выделении' : 'Этого нет в выделении'}: [ и ] — мельче или крупнее`, `${e.op === 'add' ? 'Already selected' : 'Not in the selection'}: [ and ] — smaller or larger`), false);
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
  const saveObject = async (cut = false): Promise<ObjectDto | undefined> => {
    if (!doc || !selection.some((s) => !s.erase)) return;
    try {
      // Копия ложится сверху выбранной группы или группы слоя, в котором работают
      const group = activeGroup ?? activeObj?.group;
      const { id } = await post<{ id: string }>(cut ? '/api/objects/cut' : '/api/objects', { shapes: selection, group });
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
        setActiveGroup(null);
        notify(L(`Слой «${o.name}»`, `Layer “${o.name}”`), false);
      }
      return o;
    } catch (err) {
      fail(err);
    }
  };
  /** ⌘⇧J: то же, но на старом месте — дыра у того, чьи пиксели там были (в фоне — белое). Генерации нет */
  const cutObject = () => saveObject(true);
  /** ⌘E: слои в выделении (Shift-щелчком в списке) и тот, в котором работают, — одним слоем; работа сразу в нём */
  const mergeLayers = async () => {
    const ids = [...new Set([...selectedObjects, ...(active ? [active] : [])])];
    if (ids.length < 2) {
      notify(L('Выделите в «Слоях» два слоя или больше: Shift-щелчок', 'Select two or more layers in Layers: Shift-click'), false);
      return;
    }
    try {
      const { id } = await post<{ id: string }>('/api/objects/merge', { ids });
      const seq = ++refreshSeq.current;
      const s = await getState();
      if (seq === refreshSeq.current) setState(s);
      const o = s.objects.find((x) => x.id === id);
      if (o) enterLayer(o);
      notify(L('Слои объединены. ⌘Z вернёт их', 'Layers merged. ⌘Z brings them back'), false);
    } catch (err) {
      fail(err);
    }
  };
  /** ⌘G: выбранная группа, слои в выделении (Shift-щелчком в списке) или тот, в котором работают, — в новую группу */
  const groupLayers = async () => {
    const ids = activeGroup ? [activeGroup] : [...new Set([...selectedObjects, ...(active ? [active] : [])])];
    if (!ids.length) {
      notify(L('Выберите в «Слоях» слои: щелчок или Shift-щелчок', 'Select layers in Layers: click or Shift-click'), false);
      return;
    }
    try {
      const { id } = await post<{ id: string }>('/api/groups', { ids });
      // Состояние — с новой группой: иначе её выбор сбросился бы как выбор ушедшей
      const seq = ++refreshSeq.current;
      const s = await getState();
      if (seq === refreshSeq.current) setState(s);
      setActive(null);
      setActiveGroup(id);
    } catch (err) {
      fail(err);
    }
  };
  /** ⇧⌘G: слои из группы — на её место */
  const ungroup = (g: GroupDto | undefined) => {
    if (!g) {
      notify(L('Выберите группу в «Слоях»', 'Select a group in Layers'), false);
      return;
    }
    post(`/api/groups/${g.id}/ungroup`).then(() => setActiveGroup(null), fail);
  };
  const deleteGroup = (g: GroupDto) => {
    post(`/api/groups/${g.id}/delete`)
      .then(() => {
        setActiveGroup(null);
        clearSelection();
        notify(L(`Группа «${short(g.name)}» удалена со слоями. ⌘Z вернёт`, `Group “${short(g.name)}” deleted with its layers. ⌘Z brings it back`), false);
      })
      .catch(fail);
  };
  /**
   * Щелчок по группе в «Слоях»: её видимые слои — в выделение, новый слой ляжет сверху в неё. С ⌘ или Shift — её слои
   * добавляются к выделению; второй щелчок — назад к картинке
   */
  const selectGroup = (g: GroupDto, add: boolean) => {
    const byId = new Map(groups.map((x) => [x.id, x]));
    const within = (o: ObjectDto) => {
      for (let i = 0, id = o.group; id && i < 64; i++, id = byId.get(id)?.group) if (id === g.id) return true;
      return false;
    };
    const shapes = objects.filter((o) => o.kind !== 'fill' && o.visible && within(o)).map(objectShape);
    setActive(null);
    setActiveJob(null);
    if (add) {
      const ids = new Set(shapes.map((x) => (x as MaskRef).id));
      updateSelection((sel) => [...sel.filter((x) => !(x.kind === 'mask' && ids.has(x.id))), ...shapes]);
      setActiveGroup(null);
    } else if (activeGroup === g.id) {
      setActiveGroup(null);
      clearSelection();
    } else {
      formOrder.current = formOrder.current.filter((k) => k !== 'shape');
      if (shapes.length) formOrder.current.push('shape');
      updateSelection(() => shapes);
      setActiveGroup(g.id);
    }
  };
  /** Влить слой в фон: то, что от него видно, становится исходником */
  const mergeDown = (o: ObjectDto | undefined) => {
    if (!o) {
      notify(L('Откройте слой: щелчок по нему', 'Open a layer: click it'), false);
      return;
    }
    post(`/api/objects/${o.id}/merge-down`).then(() => {
      if (active === o.id) setActive(null);
      clearSelection();
      notify(L(`«${short(o.name)}» влит в фон. ⌘Z вернёт`, `“${short(o.name)}” merged into the background. ⌘Z brings it back`), false);
    }, fail);
  };
  /** Свести все слои в плоскую картинку */
  const flatten = () =>
    post('/api/doc/flatten').then(() => {
      setActive(null);
      clearSelection();
      notify(L('Слои сведены. ⌘Z вернёт их', 'Layers flattened. ⌘Z brings them back'), false);
    }, fail);
  /**
   * Щелчок по слою в списке — работа в нём: его маска становится выделением; с ⌘ или Shift — маска добавляется
   * к выделению или убирается из него, а слой, в котором работают, тот же
   */
  const selectObject = (o: ObjectDto, add: boolean) => {
    const shape = objectShape(o);
    setActiveGroup(null);
    setActiveJob(null);
    if (add) {
      // Несколько слоёв вместе правят новым слоем поверх них
      const has = selection.some((s) => s.kind === 'mask' && s.id === shape.id && !s.erase);
      if (!has) formOrder.current.push('shape');
      updateSelection((sel) => (has ? sel.filter((s) => !(s.kind === 'mask' && s.id === shape.id)) : [...sel, shape]));
      setActive(null);
    } else if (active === o.id && maskLayer === o.id) {
      // Правили маску — щелчок по слою возвращает к его пикселям, как в Photoshop
      setMaskLayer(null);
    } else if (active === o.id) {
      // Второй щелчок по слою, в котором работают, — назад к картинке
      setActive(null);
      clearSelection();
    } else {
      enterLayer(o);
      viewRef.current?.reveal(o.rect);
    }
  };
  /**
   * Щелчок по фону в «Слоях» — работа вне слоёв, генерация ляжет новым слоем. Маски слоёв уходят из выделения,
   * нарисованное остаётся
   */
  const toBackground = () => {
    setActive(null);
    setActiveGroup(null);
    setActiveJob(null);
    const own = selectionRef.current.filter((s) => !(s.kind === 'mask' && s.id.startsWith('obj:')));
    if (!own.length) clearSelection();
    else if (own.length < selectionRef.current.length) updateSelection(() => own);
  };
  /** Работа в слое: он выделен целиком, генерация ляжет его версией */
  const enterLayer = (o: ObjectDto) => {
    formOrder.current = formOrder.current.filter((k) => k !== 'shape');
    formOrder.current.push('shape');
    updateSelection(() => [objectShape(o)]);
    setActive(o.id);
    setActiveGroup(null);
    setActiveJob(null);
  };
  /** Генерация нового слоя в «Слоях»: её ход и ошибка — в ленте, рамка — на холсте */
  const selectJob = (j: JobDto) => {
    setActive(null);
    setActiveGroup(null);
    setActiveJob(j.id);
    focus(j);
  };
  const selectedObjects = new Set(selection.flatMap((s) => (s.kind === 'mask' && s.id.startsWith('obj:') && !s.erase ? [s.id.slice(4)] : [])));

  /** Дорисовать фон под слоем: в слоях, где под ним дыра, — их версиями; где только фон — новым слоем внизу */
  const fillUnder = async (o: ObjectDto) => {
    if (needsKey(model) && !state?.hasKey) {
      setDialog('settings');
      return;
    }
    try {
      const { ids } = await post<{ ids: string[] }>(`/api/objects/${o.id}/fill`, { variants, model, size: sizeFor(model) });
      if (ids.length > 1) notify(`${L('Фон дорисуется в', 'The background will be filled in')} ${ids.length} ${plural(ids.length, ['слое', 'слоях', 'слоях'], ['layer', 'layers'])}`, false);
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
  // Директор идёт через Codex; у подставной модели — подставной директор
  const canDirect = state?.provider === 'mock' || !!state?.codex;
  // Поправка задачи версии: у неё свои «С нуля» и директор, модель, разрешение и референсы — версии
  const redoPatch = redoing ? layers.find((p) => p.id === redoing.patch) : undefined;
  const redoObj = redoPatch ? objects.find((o) => o.versions.includes(redoPatch.id)) : undefined;
  const optHide = redoing ? redoing.hide : hide;
  const setOptHide = (v: boolean) => (redoing ? setRedoing({ ...redoing, hide: v }) : setHide(v));
  // С директором правка идёт шагами с критиком, а не вариантами разом
  const stepwise = (redoing ? redoing.director : director) && canDirect;
  const setOptDirector = (v: boolean) => (redoing ? setRedoing({ ...redoing, director: v }) : setDirector(v));
  const countFor = (withDirector: boolean) => (withDirector ? steps : variants);
  // У ChatGPT одно разрешение — его выбирает сама модель
  const sizeFor = (m: ModelChoice): SizeChoice => (m === 'chatgpt' ? 'auto' : size);
  const sizeAdvice = doc && state && hasSelection ? adviseSelection(doc, selection, state.models[model], sizeFor(model)) : null;
  // Рамка куска, который увидит модель, — на холсте, пока есть выделение
  const modelFrame = sizeAdvice && typeof sizeAdvice === 'object' && !maskLayer ? sizeAdvice.frame.inside : null;
  useEffect(() => viewRef.current?.setModelFrame(modelFrame), [JSON.stringify(modelFrame)]);

  /** Группа или та, в которой она лежит, скрыта */
  const groupHidden = (id: string | undefined) => {
    for (let i = 0, g = groups.find((x) => x.id === id); g && i < 64; i++, g = groups.find((x) => x.id === g!.group)) if (g.hidden) return true;
    return false;
  };
  const hiddenWhy = (o: ObjectDto) => (o.hidden ? L('слой скрыт', 'layer is hidden') : L('группа скрыта', 'group is hidden'));
  // Куда ляжет правка и почему её сейчас не сделать — подписью на кнопке генерации
  let target: string;
  let blocked = maskLayer ? L('идёт правка маски', 'mask is being edited') : '';
  if (redoPatch) {
    target = redoObj ? L(`к версии ${redoObj.versions.indexOf(redoPatch.id) + 1}`, `to version ${redoObj.versions.indexOf(redoPatch.id) + 1}`) : L('к версии', 'to the version');
    if (redoObj && !redoObj.visible) blocked ||= hiddenWhy(redoObj);
  } else {
    if (activeObj) {
      target = L(`в «${short(activeObj.name, 24)}»`, `into “${short(activeObj.name, 24)}”`);
      if (!activeObj.visible) blocked ||= hiddenWhy(activeObj);
    } else if (activeGrp) {
      target = L(`новым слоем в «${short(activeGrp.name, 20)}»`, `as a new layer in “${short(activeGrp.name, 20)}”`);
      if (groupHidden(activeGrp.id)) blocked ||= L('группа скрыта', 'group is hidden');
    } else if (selectedObjects.size > 1) {
      target = L('новым слоем сверху', 'as a new layer on top');
    } else {
      target = prompt.trim() ? L(`новым слоем «${short(layerName(prompt), 22)}»`, `as new layer “${short(layerName(prompt), 22)}”`) : L('новым слоем', 'as a new layer');
    }
    if (!hasSelection) blocked ||= L('выделите область', 'select an area');
  }
  const canGenerate = !!doc && !blocked && prompt.trim().length > 0;
  const count = countFor(stepwise);
  // Генераций в счётчике: варианты и маски по объекту; директор и критик не считаются
  const cost = count * (autoMask ? 2 : 1);

  /** Поправить задачу версии: она — в поле правки, черновик новой правки ждёт */
  const startRedo = (patch: PatchDto) => {
    setRedoing({ patch: patch.id, draft: redoing ? redoing.draft : prompt, hide: patch.hide ?? false, director: patch.directed !== undefined });
    setPrompt(patch.prompt);
    window.setTimeout(() => {
      promptRef.current?.focus();
      promptRef.current?.select();
    });
  };
  const endRedo = () => {
    if (!redoing) return;
    setPrompt(redoing.draft);
    setRedoing(null);
  };

  const generate = async () => {
    if (!canGenerate) return;
    if (redoing && redoPatch) {
      const change: RedoChange = { prompt: prompt.trim(), hide: redoing.hide, director: stepwise, objectMask: autoMask };
      endRedo();
      await layerVariants(redoPatch, change);
      return;
    }
    if (needsKey(model) && !state?.hasKey) {
      setDialog('settings');
      return;
    }
    try {
      const { id } = await post<{ id: string }>('/api/jobs', {
        shapes: selection,
        object: activeObj?.id,
        group: activeObj ? undefined : (activeGroup ?? undefined),
        prompt,
        variants: count,
        model,
        size: sizeFor(model),
        refs,
        hide,
        sketch: hasSketch ? sketch : undefined,
        director: stepwise,
        objectMask: autoMask,
      });
      // Новый слой появится с первым готовым вариантом: до тех пор в ленте — ход его генерации
      if (!activeObj) {
        setActiveGroup(null);
        setActiveJob(id);
      }
      // Форма — для следующей области: задача, набросок, референсы и скрытие у неё свои; модель, разрешение, число вариантов, директор и маска остаются
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

  /** F: холст — по куску слоя, в котором работают; ещё раз — вся картинка */
  const toggleFocus = () => {
    if (!activeObj) return;
    if (focused) {
      viewRef.current?.fit();
      setFocused(false);
      return;
    }
    const shown = layers.find((p) => p.id === (activeObj.current ?? activeObj.layer));
    viewRef.current?.showRect(shown?.rect ?? activeObj.rect);
    setFocused(true);
  };

  // Версия, на которую навели в ленте: холст под слоем (от того, что видно сейчас), она и то, что над слоем
  const peekView = ((): PeekView | null => {
    const o = peek ? objects.find((x) => x.id === peek.object) : undefined;
    if (!peek || !doc || !o?.visible || maskLayer) return null;
    const byId = (id: string | null | undefined) => (id ? layers.find((p) => p.id === id) : undefined);
    const shown = byId(o.current ?? o.layer);
    const target = byId(peek.patch ?? o.layer);
    if ((target?.id ?? null) === (shown?.id ?? null)) return null;
    const under = shown ?? target;
    if (!under) return null;
    const q = `doc=${doc.id}&rev=${doc.rev}`;
    const view: PeekView = { below: { url: `/api/history/${under.id}/edit/below.jpg?${q}`, rect: under.rect } };
    if (target) view.layer = { url: `/api/history/${target.id}/cutout.png?${q}`, rect: target.rect };
    if (shown) view.above = { url: `/api/history/${shown.id}/edit/above.png?${q}`, rect: shown.rect };
    return view;
  })();
  useEffect(() => viewRef.current?.setPeek(peekView), [JSON.stringify(peekView)]);

  // Генерации с ошибкой: их число — в верхней полосе, щелчок ведёт к первой
  const failedJobs = jobs.filter((j) => j.status === 'error');
  const showError = () => {
    const j = failedJobs[0];
    const o = j?.object ? objects.find((x) => x.id === j.object) : undefined;
    if (o) {
      enterLayer(o);
      setErrorJob(j!.id);
    } else if (j) selectJob(j);
  };
  const onJob = (job: JobDto, action: JobAction) => {
    if ((action === 'retry' || action === 'more') && needsKey(job.model) && !state?.hasKey) setDialog('settings');
    else if (action === 'more' || action === 'retry') redoJob(job).catch(fail);
    else post(`/api/jobs/${job.id}/${action}`).catch(fail);
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
      if (path) notify(L(`${how === 'export' ? 'Экспортировано' : 'Сохранено'}: ${fileName(path)}`, `${how === 'export' ? 'Exported' : 'Saved'}: ${fileName(path)}`), false);
    } catch (err) {
      fail(err);
    }
  };

  const addReferences = async (files: Iterable<File>) => {
    const images = [...files].filter((f) => f.type.startsWith('image/'));
    if (!images.length) return;
    const room = MAX_REFERENCES - refs.length;
    if (room <= 0) {
      notify(L(`Не больше ${MAX_REFERENCES} референсов на правку`, `No more than ${MAX_REFERENCES} references per edit`));
      return;
    }
    if (images.length > room) notify(L(`Добавлю только ${room}: не больше ${MAX_REFERENCES} референсов на правку`, `Adding only ${room}: no more than ${MAX_REFERENCES} references per edit`));
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
      case 'group-layers':
        void groupLayers();
        break;
      case 'ungroup':
        ungroup(activeGrp);
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
      // В поле Esc только уводит из него: набранное и выделение остаются
      if (typing) (e.target as HTMLElement).blur();
      else if (zoomMenu) setZoomMenu(false);
      else if (dialog) setDialog(null);
      else if (redoing) endRedo();
      else if (maskLayer) setMaskLayer(null);
      // Сначала снимается выделение, потом — работа в слое или в группе
      else if (selection.length || (!activeObj && !activeGrp)) clearSelection();
      else {
        setActive(null);
        setActiveGroup(null);
      }
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
        g: 'group-layers',
        '0': 'zoom-fit',
        '1': 'zoom-100',
        '2': 'zoom-50',
        '=': 'zoom-in',
        '+': 'zoom-in',
        '-': 'zoom-out',
      };
      const command =
        e.shiftKey && key === 's'
          ? 'save-as'
          : e.shiftKey && key === 'e'
            ? 'export'
            : e.shiftKey && key === 'j'
              ? 'cut-object'
              : e.shiftKey && key === 'g'
                ? 'ungroup'
                : e.shiftKey || e.altKey
                  ? undefined
                  : byKey[key];
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
    // F — холст по куску слоя, в котором работают, и обратно
    if (e.code === 'KeyF') {
      toggleFocus();
      return;
    }
    // X при правке маски — скрывать или возвращать, как смена цветов в Photoshop
    if (e.code === 'KeyX' && maskLayer) {
      setMaskOp((op) => (op === 'sub' ? 'add' : 'sub'));
      return;
    }
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
    setBusy(L(`Открываю ${file.name}…`, `Opening ${file.name}…`));
    try {
      await upload(file);
      refresh();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  };

  const saveStyle = (style: string) => post('/api/doc/style', { style }).then(() => setDialog(null), fail);

  /** Щелчок по миниатюре маски: работа в слое, кисть правит маску того, что от него видно. Прежде всего — чтобы скрыть кусок */
  const editLayerMask = (o: ObjectDto) => {
    const shown = layers.find((p) => p.id === (o.current ?? o.layer));
    if (!shown) return;
    if (active !== o.id) enterLayer(o);
    if (maskLayer === o.id) return;
    setMaskLayer(o.id);
    setMaskOp('sub');
    setTool('brush');
    viewRef.current?.reveal(shown.rect);
  };

  /** Маска версии по объекту, который нарисовала модель: её рисует модель из формы — это генерация */
  const objectMask = async (patch: PatchDto) => {
    setBusy(L('Модель рисует маску…', 'The model is drawing the mask…'));
    try {
      await post(`/api/history/${patch.id}/object-mask`, { model } satisfies ObjectMaskRequest);
      maskChanged();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  };

  const focus = (job: JobDto) => {
    const r = job.inside ?? job.bbox;
    if (r) viewRef.current?.showRect(r);
  };

  /** Ещё варианты (с директором — шаги) задачи в очереди, можно с поправкой; с ошибкой до подготовки куска — начать её заново */
  const redoJob = (job: JobDto, change: RedoChange = {}) =>
    job.inside
      ? post(`/api/jobs/${job.id}/more`, { count: countFor(change.director ?? job.director), objectMask: autoMask, ...change })
      : post(`/api/jobs/${job.id}/retry`, { objectMask: autoMask, ...change });

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
        else notify(L('Варианты этой версии уже генерируются', 'Variants of this version are already generating'), false);
        return;
      }
      const count = countFor(change.director ?? patch.directed !== undefined);
      await post(`/api/history/${patch.id}/variants`, { variants: count, model, size: sizeFor(model), objectMask: autoMask, ...change });
      viewRef.current?.showRect(patch.rect);
    } catch (err) {
      fail(err);
    }
  };

  const deleteVersion = (patch: PatchDto) => {
    post(`/api/history/${patch.id}/delete`)
      .then(() => notify(L('Версия удалена. ⌘Z вернёт её', 'Version deleted. ⌘Z brings it back'), false))
      .catch(fail);
  };
  const deleteObject = (o: ObjectDto) => {
    post(`/api/objects/${o.id}/delete`)
      .then(() => notify(L(`Слой «${short(o.name)}» ${o.freed ? 'убран с холста' : 'удалён'}. ⌘Z вернёт его`, `Layer “${short(o.name)}” ${o.freed ? 'removed from the canvas' : 'deleted'}. ⌘Z brings it back`), false))
      .catch(fail);
  };
  const expandVersion = (patch: PatchDto) => {
    post<{ addedPx: number }>(`/api/history/${patch.id}/expand`)
      .then(({ addedPx }) => {
        if (addedPx) maskChanged();
        const area = patch.rect.width * patch.rect.height;
        notify(addedPx ? L(`Маска выросла на ${((100 * addedPx) / area).toFixed(1)}% куска`, `Mask grew by ${((100 * addedPx) / area).toFixed(1)}% of the crop`) : L('За краем маски модель ничего не дорисовала', 'The model drew nothing beyond the mask edge'), false);
      })
      .catch(fail);
  };

  return (
    <div class={['app', doc ? '' : 'no-doc', bandFolded ? 'band-folded' : ''].filter(Boolean).join(' ')}>
      <header class="topbar">
        <div class="doc-title" title={doc?.path ?? undefined}>
          {doc ? (
            <>
              <strong>{doc.name}</strong>
              {doc.dirty && (
                <span class="unsaved" title={L('Принятые правки ещё не записаны в файл (⌘S)', 'Changes are not written to the file yet (⌘S)')}>
                  {L('не сохранено', 'unsaved')}
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
                title={L('Отменить (⌘Z)', 'Undo (⌘Z)')}
                aria-label={L('Отменить', 'Undo')}
                disabled={!state?.canUndo && !selection.length && !sketch.length}
                onClick={undo}
              >
                <IconArrowBackUp size={20} stroke={STROKE} />
              </button>
              <button class="ghost icon" title={L('Повторить (⇧⌘Z)', 'Redo (⇧⌘Z)')} aria-label={L('Повторить', 'Redo')} disabled={!state?.canRedo} onClick={redo}>
                <IconArrowForwardUp size={20} stroke={STROKE} />
              </button>
              <span class="sep" />
              <div class="zoom-control">
                <button class="ghost icon" title={L('Уменьшить (⌘−)', 'Zoom out (⌘−)')} aria-label={L('Уменьшить', 'Zoom out')} onClick={() => run('zoom-out')}>
                  <IconMinus size={18} stroke={STROKE} />
                </button>
                <button
                  class="ghost zoom"
                  title={L('Масштаб', 'Zoom')}
                  aria-haspopup="menu"
                  aria-expanded={zoomMenu}
                  onClick={() => setZoomMenu((v) => !v)}
                >
                  {zoom}%
                </button>
                <button class="ghost icon" title={L('Увеличить (⌘=)', 'Zoom in (⌘=)')} aria-label={L('Увеличить', 'Zoom in')} onClick={() => run('zoom-in')}>
                  <IconPlus size={18} stroke={STROKE} />
                </button>
                {zoomMenu && (
                  <ul class="zoom-menu" role="menu" onClick={() => setZoomMenu(false)}>
                    <li role="menuitem" onClick={() => run('zoom-fit')}>
                      {L('Вписать в окно', 'Fit to window')} <kbd>⌘0</kbd>
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
                title={doc.path && !doc.saveBlocker ? L(`Записать в ${fileName(doc.path)} (⌘S)`, `Write to ${fileName(doc.path)} (⌘S)`) : L('Сохранить в файл (⌘S)', 'Save to file (⌘S)')}
                onClick={() => void save('save')}
              >
                {L('Сохранить', 'Save')}
              </button>
            </>
          )}
        </div>
        <div class="counter" title={L('Каждая генерация платная', 'Every generation costs money')}>
          {failedJobs.length > 0 && (
            <button class="errs" title={L('Показать', 'Show')} onClick={showError}>
              <IconAlertTriangle size={14} stroke={STROKE} aria-hidden="true" />
              {failedJobs.length} {plural(failedJobs.length, ['ошибка', 'ошибки', 'ошибок'], ['error', 'errors'])}
            </button>
          )}
          {state?.provider === 'mock' && <span class="badge">{L('подставная модель', 'mock model')}</span>}
          {L('Генераций:', 'Generations:')} {state?.generations.session ?? 0} {L('за сеанс,', 'this session,')} {state?.generations.today ?? 0} {L('сегодня', 'today')}
        </div>
      </header>

      <div class="optbar" role="toolbar" aria-label={L('Настройки инструмента', 'Tool options')}>
        {doc &&
          (editedLayer ? (
            <>
              <span class="opt-title">
                <IconMask size={16} stroke={STROKE} aria-hidden="true" />
                {L(`Маска «${short(objects.find((o) => o.id === editedLayer.object)?.name ?? editedLayer.prompt, 24)}»`, `Mask “${short(objects.find((o) => o.id === editedLayer.object)?.name ?? editedLayer.prompt, 24)}”`)}
                <Help>{L('Кисть и фигуры скрывают часть версии или возвращают её — и за краем прежнего выделения. Alt — наоборот, X — сменить. ⌘Z отменяет мазок.', 'The brush and shapes hide part of the version or bring it back — even beyond the original selection. Alt does the opposite, X switches. ⌘Z undoes a stroke.')}</Help>
              </span>
              {tool !== 'hand' && (
                <>
                  <span class="opt-sep" />
                  <Seg
                    label={L('Кисть по маске', 'Mask brush')}
                    value={maskOp}
                    options={[
                      { value: 'add' as const, icon: IconLayersUnion, title: L('Вернуть часть версии (X)', 'Reveal part of the version (X)') },
                      { value: 'sub' as const, icon: IconLayersSubtract, title: L('Скрыть часть версии (X, Alt)', 'Hide part of the version (X, Alt)') },
                    ]}
                    onChange={setMaskOp}
                  />
                </>
              )}
              {tool === 'brush' && (
                <>
                  <Slider label={L('Размер', 'Size')} title={L('Размер кисти на экране ([ и ])', 'Brush size on screen ([ and ])')} min={4} max={400} value={brush} onChange={setBrush} />
                  <Slider
                    label={L('Мягкость', 'Softness')}
                    title={L('0% — жёсткий край, 100% — затухает от середины (⇧[ и ⇧])', '0% — hard edge, 100% — fades from the center (⇧[ and ⇧])')}
                    min={0}
                    max={100}
                    step={5}
                    value={Math.round(softness * 100)}
                    unit="%"
                    onChange={(v) => setSoftness(v / 100)}
                  />
                </>
              )}
              <span class="opt-sep" />
              <button class="opt-button" title={L('Маска по объекту: её рисует модель из формы — это генерация', 'Object mask: drawn by the model chosen in the edit panel — this is a generation')} onClick={() => void objectMask(editedLayer)}>
                <IconSparkles size={16} stroke={STROKE} aria-hidden="true" />
                {L('По объекту', 'By object')}
              </button>
              <button class="opt-done" onClick={() => setMaskLayer(null)}>
                {L('Готово', 'Done')}
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
              {SELECTING.includes(tool) && (
                <>
                  <span class="opt-sep" />
                  <Seg
                    label={L('Режим выделения', 'Selection mode')}
                    value={tool === 'brush' && selectMode === 'new' ? 'add' : selectMode}
                    options={[
                      ...(tool === 'brush' ? [] : [{ value: 'new' as const, icon: IconSquare, title: L('Новое выделение', 'New selection') }]),
                      { value: 'add' as const, icon: IconLayersUnion, title: L('Добавить к выделению (Shift)', 'Add to selection (Shift)') },
                      { value: 'sub' as const, icon: IconLayersSubtract, title: L('Вычесть из выделения (Alt)', 'Subtract from selection (Alt)') },
                    ]}
                    onChange={setSelectMode}
                  />
                </>
              )}
              {tool === 'object' && (
                <>
                  {currentPick && currentPick.levels.length > 1 && (
                    <Seg
                      label={L('Уровень объекта', 'Object level')}
                      value={currentPick.level}
                      options={levelNames(currentPick.levels.length).map((name, i) => ({ value: i, text: name, title: L('Мельче или крупнее: [ и ] или щелчок туда же', 'Smaller or larger: [ and ] or click the same spot') }))}
                      onChange={(i) => stepLevel(i - currentPick.level)}
                    />
                  )}
                  <OptCheck label={L('По линиям', 'Snap to lines')} title={L('Край выделения — по линиям рисунка, с контуром', 'Selection edge follows the lines of the drawing, outline included')} checked={objectSnap} onChange={setObjectSnap} />
                </>
              )}
              {tool === 'brush' && (
                <>
                  <Slider label={L('Размер', 'Size')} title={L('Размер кисти на экране ([ и ])', 'Brush size on screen ([ and ])')} min={4} max={400} value={brush} onChange={setBrush} />
                  <OptCheck label={L('По линиям', 'Snap to lines')} title={L('Клетки рисунка, которые задел мазок, — целиком, с контуром', 'Drawing cells the stroke touched — whole, with their outline')} checked={brushSnap} onChange={setBrushSnap} />
                </>
              )}
              {tool === 'sketch' && (
                <>
                  <span class="opt-sep" />
                  <Slider label={L('Толщина', 'Thickness')} title={L('Толщина наброска на экране ([ и ])', 'Sketch thickness on screen ([ and ])')} min={2} max={120} value={sketchSize} onChange={setSketchSize} />
                  <div class="sketch-colors" role="radiogroup" aria-label={L('Цвет наброска', 'Sketch color')}>
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
                    <label class={SKETCH_COLORS.includes(sketchColor) ? 'swatch custom' : 'swatch custom active'} title={L('Другой цвет', 'Other color')} style={{ background: sketchColor }}>
                      <input type="color" value={sketchColor} aria-label={L('Другой цвет наброска', 'Other sketch color')} onInput={(e) => setSketchColor(e.currentTarget.value)} />
                    </label>
                  </div>
                </>
              )}
              {SELECTING.includes(tool) && hasSelection && (
                <>
                  <span class="opt-sep" />
                  <Slider label={L('Край', 'Edge')} title={L('Край выделения шире или уже, пиксели холста', 'Expand or contract the selection edge, in canvas pixels')} min={-50} max={50} value={edgePx} onChange={changeEdge} />
                </>
              )}
              {selection.length > 0 && (
                <span class="opt-actions">
                  {hasSelection && !(selectedObjects.size === 1 && selection.length === 1) && (
                    <>
                      <button class="icon" title={L('Слой из выделения: копия того, что видно (⌘J)', 'Layer via Copy: a copy of what is visible (⌘J)')} aria-label={L('Слой из выделения', 'Layer via Copy')} onClick={() => void saveObject()}>
                        <IconCubePlus size={16} stroke={STROKE} />
                      </button>
                      <button class="icon" title={L('Вырезать в слой: на старом месте — пусто (⌘⇧J)', 'Layer via Cut: leaves a hole behind (⌘⇧J)')} aria-label={L('Вырезать в слой', 'Layer via Cut')} onClick={() => void cutObject()}>
                        <IconScissors size={16} stroke={STROKE} />
                      </button>
                    </>
                  )}
                  <button class="icon" title={L('Снять выделение (⌘D)', 'Deselect (⌘D)')} aria-label={L('Снять выделение', 'Deselect')} onClick={clearSelection}>
                    <IconMarqueeOff size={16} stroke={STROKE} />
                  </button>
                </span>
              )}
            </>
          ))}
      </div>

      <nav class="rail" aria-label={L('Инструменты', 'Tools')}>
        {TOOLS.map((t) => {
          const ToolIcon = TOOL_ICONS[t.id];
          // Набросок — подсказка модели к новой правке, а не выделение: отдельно от инструментов выделения.
          // Набросок, «Палочка» и «Сдвинуть» — не для правки маски
          const formOnly = (t.id === 'sketch' || t.id === 'object' || t.id === 'move') && !!maskLayer;
          const button = (
            <button
              key={t.id}
              class={tool === t.id ? 'tool active' : 'tool'}
              title={formOnly ? L(`${t.label} — только для новой правки`, `${t.label} — only for a new edit`) : `${t.label} (${t.key})`}
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
        {comparing && <div class="stage-banner">{L('Исходник', 'Original')}</div>}
        {!doc && state && <StartScreen recent={state.recent} onOpen={openDialog} onOpenRecent={openRecent} onError={fail} />}
        {(busy ?? state?.activity) && <div class="busy">{busy ?? state?.activity}</div>}
        {toast && <div class={toast.error ? 'toast error' : 'toast'}>{toast.text}</div>}
      </main>

      {doc && (
        <VersionsBand
          doc={doc}
          objects={objects}
          groups={groups}
          patches={layers}
          jobs={jobs}
          active={activeObj}
          group={activeGrp}
          picked={!activeObj && !activeGrp && selectedObjects.size > 1 ? objects.filter((o) => selectedObjects.has(o.id)) : []}
          job={selJob}
          errorJob={errorJob}
          maskLayer={maskLayer}
          folded={bandFolded}
          focused={focused}
          variants={variants}
          steps={steps}
          onFold={() => setBandFolded((v) => !v)}
          onFocus={toggleFocus}
          onPeek={(o, patch) => setPeek(o ? { object: o.id, patch: patch ?? null } : null)}
          onCurrent={(o, patch) => post(`/api/objects/${o.id}/current`, { patch }).catch(fail)}
          onEnter={(o) => {
            enterLayer(o);
            viewRef.current?.reveal(o.rect);
          }}
          onError={setErrorJob}
          onMore={(p) => void layerVariants(p)}
          onRedo={startRedo}
          onObjectMask={(p) => void objectMask(p)}
          onExpand={expandVersion}
          onDeleteVersion={deleteVersion}
          onJob={onJob}
          onGroup={() => void groupLayers()}
          onMerge={() => void mergeLayers()}
          onUngroup={ungroup}
          onDeleteGroup={deleteGroup}
        />
      )}

      <aside class="side">
        {doc && (
          <>
            <LayersPanel
              doc={doc}
              objects={objects}
              groups={groups}
              patches={layers}
              jobs={jobs}
              active={active}
              activeGroup={activeGroup}
              activeJob={activeJob}
              picked={selectedObjects}
              maskLayer={maskLayer}
              onSelect={selectObject}
              onMask={editLayerMask}
              onEnter={(o) => {
                if (active !== o.id) enterLayer(o);
              }}
              onSelectGroup={selectGroup}
              onSelectJob={selectJob}
              onBackground={toBackground}
              onHover={(o) => setLitObject(o?.id ?? null)}
              onRename={(o, name) => post(`/api/objects/${o.id}/rename`, { name }).catch(fail)}
              onRenameGroup={(g, name) => post(`/api/groups/${g.id}/rename`, { name }).catch(fail)}
              onHidden={(o, hidden) => post(`/api/objects/${o.id}/hidden`, { hidden }).catch(fail)}
              onGroupHidden={(g, hidden) => post(`/api/groups/${g.id}/hidden`, { hidden }).catch(fail)}
              onFill={(o) => void fillUnder(o)}
              onMergeDown={mergeDown}
              onDelete={deleteObject}
              onGroup={() => void groupLayers()}
              onMerge={() => void mergeLayers()}
              onFlatten={() => void flatten()}
              onUngroup={ungroup}
              onDeleteGroup={deleteGroup}
              onMove={(id, into, over) => post(`/api/layers/${id}/move`, { into, over }).catch(fail)}
              onJob={onJob}
            />

            <section
              class="compose"
              aria-label={L('Правка', 'Edit')}
              onDragOver={(e) => {
                if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
              }}
              onDrop={(e) => {
                e.preventDefault();
                void addReferences(e.dataTransfer?.files ?? []);
              }}
            >
              {state && !state.hasKey && needsKey(redoPatch?.model ?? model) && (
                <p class="compose-key">
                  {L(`Нужен ключ ${GEMINI_SERVICE_NAMES[state.gemini.service]}`, `${GEMINI_SERVICE_NAMES[state.gemini.service]} key needed`)}
                  <button class="link" onClick={() => setDialog('settings')}>
                    {L('Настройки', 'Settings')}
                  </button>
                </p>
              )}
              <div class="compose-box">
                <textarea ref={promptRef} rows={2} placeholder={L('Что должно получиться', 'Describe the result')} aria-label={L('Задача', 'Task')} value={prompt} onInput={(e) => setPrompt(e.currentTarget.value)} />
                <div class="compose-attach">
                  {redoPatch ? (
                    <span class="redo-chip" title={L('Модель, разрешение и референсы — как у версии', 'Model, resolution and references — same as the version')}>
                      <IconPencil size={14} stroke={STROKE} aria-hidden="true" />
                      {L('Поправка версии', 'Revising version')} {redoObj ? redoObj.versions.indexOf(redoPatch.id) + 1 : ''}
                      <button title={L('Не поправлять (Esc)', 'Cancel revision (Esc)')} aria-label={L('Не поправлять', 'Cancel revision')} onClick={endRedo}>
                        <IconX size={14} stroke={2} />
                      </button>
                    </span>
                  ) : (
                    <>
                      {refs.map((id) => (
                        <span class="ref" key={id}>
                          <img src={`/api/refs/${id}/thumb.jpg`} alt={L('Референс', 'Reference')} />
                          <button class="ref-remove" aria-label={L('Убрать референс', 'Remove reference')} onClick={() => setRefs((r) => r.filter((x) => x !== id))}>
                            <IconX size={10} stroke={2.5} />
                          </button>
                        </span>
                      ))}
                      {refs.length < MAX_REFERENCES && (
                        <button class="att" title={L('Референс: или перетащите картинку сюда, или вставьте её через ⌘V', 'Reference: or drag an image here, or paste one with ⌘V')} aria-label={L('Референс', 'Reference')} onClick={() => refRef.current?.click()}>
                          <IconPhotoPlus size={15} stroke={STROKE} aria-hidden="true" />
                          {!refs.length && L('Референс', 'Reference')}
                        </button>
                      )}
                      {sketch.length > 0 && (
                        <span class="att on" title={L('Набросок на холсте (S); Alt стирает', 'Sketch on the canvas (S); Alt erases')}>
                          <IconScribble size={15} stroke={STROKE} aria-hidden="true" />
                          {L('Набросок', 'Sketch')}
                          <button class="att-x" title={L('Стереть набросок', 'Clear sketch')} aria-label={L('Стереть набросок', 'Clear sketch')} onClick={clearSketch}>
                            <IconX size={13} stroke={2} />
                          </button>
                        </span>
                      )}
                      <button class={doc.style ? 'att on' : 'att'} title={doc.style ? L(`Стиль документа: ${doc.style}`, `Document style: ${doc.style}`) : L('Стиль документа', 'Document style')} onClick={() => setDialog('style')}>
                        <IconPalette size={15} stroke={STROKE} aria-hidden="true" />
                        {L('Стиль', 'Style')}
                      </button>
                    </>
                  )}
                </div>
              </div>
              <div class="compose-toggles">
                <Toggle
                  label={L('Директор', 'Director')}
                  checked={stepwise}
                  disabled={!canDirect}
                  title={canDirect ? L('ChatGPT сначала расписывает задачу, правка идёт шагами с критиком', 'ChatGPT writes out the task first; the edit goes in steps with a critic') : L('Директор работает через Codex, а он не найден', 'The director works through Codex, which was not found')}
                  onChange={setOptDirector}
                />
                <Toggle label={L('Маска по объекту', 'Object mask')} checked={autoMask} title={L('Каждой новой версии модель сразу рисует маску по объекту — ещё генерация', 'The model draws an object mask for every new version right away — one more generation each')} onChange={setAutoMask} />
                <Toggle label={L('С нуля', 'From scratch')} checked={optHide} title={L('Скрыть от модели, что под маской: она нарисует область заново', 'Hide what is under the mask from the model: it will draw the area anew')} onChange={setOptHide} />
                <Help>
                  {L('Выделите предмет «Палочкой» (W), область — прямоугольником (R), лассо (L) или кистью (B); набросок (S) подскажет модели, где и каким должно быть то, что в задаче. Модель видит кусок в пунктирной рамке, меняет — только выделенное. В слое правка ложится его версией, на фоне — новым слоем. Директор: ChatGPT смотрит на кусок и расписывает задачу, правка идёт шагами — после каждого критик говорит, что исправить. «С нуля»: модель получит область залитой серым и нарисует её заново, не держась за то, что там было. ⌘↵ — сгенерировать.', 'Select an object with the Wand (W), an area with the rectangle (R), lasso (L) or brush (B); a sketch (S) tells the model where and how the thing in the task should look. The model sees the crop in the dashed frame and changes only the selection. In a layer, the edit becomes its version; on the background, a new layer. Director: ChatGPT looks at the crop and writes out the task, and the edit goes in steps — after each one a critic says what to fix. “From scratch”: the model gets the area filled with gray and draws it anew, without holding on to what was there. ⌘↵ — generate.')}
                </Help>
              </div>
              <div class="compose-settings">
                <ModelPicker
                  model={redoPatch?.model ?? model}
                  size={sizeFor(model)}
                  sizes={state ? state.models[model].imageSizes : []}
                  advice={redoPatch ? null : sizeAdvice}
                  locked={!!redoPatch}
                  hasKey={!!state?.hasKey}
                  service={state?.gemini.service ?? 'google'}
                  onModel={setModel}
                  onSize={setSize}
                />
                <span class="stepper" title={stepwise ? L('Шаги с критиком — по очереди, пока он не скажет «готово»', 'Steps with a critic — one at a time, until it says “done”') : L('Варианты — разом', 'Variants — all at once')}>
                  <button aria-label={L('Меньше', 'Fewer')} disabled={count <= COUNTS[0]!} onClick={() => (stepwise ? setSteps : setVariants)(Math.max(COUNTS[0]!, count - 1))}>
                    <IconMinus size={14} stroke={2} />
                  </button>
                  <span>{countText(stepwise, count)}</span>
                  <button aria-label={L('Больше', 'More')} disabled={count >= COUNTS.at(-1)!} onClick={() => (stepwise ? setSteps : setVariants)(Math.min(COUNTS.at(-1)!, count + 1))}>
                    <IconPlus size={14} stroke={2} />
                  </button>
                </span>
              </div>
              <button class="go" disabled={!canGenerate} title={canGenerate ? L(`${countText(stepwise, count)}${autoMask ? ' и маски по объекту' : ''}`, `${countText(stepwise, count)}${autoMask ? ' and object masks' : ''}`) : undefined} onClick={() => void generate()}>
                <span class="go-text">
                  <b>{redoPatch ? L('Поправить', 'Revise') : L('Сгенерировать', 'Generate')}</b>
                  <small>{blocked || (prompt.trim() ? `${target} · ${cost} ${plural(cost, ['генерация', 'генерации', 'генераций'], ['generation', 'generations'])}` : target)}</small>
                </span>
                <kbd>⌘↵</kbd>
              </button>
            </section>
          </>
        )}
      </aside>

      {dialog === 'settings' && state && (
        <SettingsDialog
          gemini={state.gemini}
          codex={state.codex}
          onClose={() => setDialog(null)}
          onSaved={(text) => {
            setDialog(null);
            notify(text, false);
          }}
          onError={fail}
        />
      )}
      {dialog === 'style' && doc && <StyleDialog style={doc.style} onClose={() => setDialog(null)} onSave={(style) => void saveStyle(style)} />}
      {dialog === 'new' && (
        <div class="modal-backdrop" onClick={() => setDialog(null)}>
          <div class="modal wide" role="dialog" aria-modal="true" aria-labelledby="new-title" onClick={(e) => e.stopPropagation()}>
            <h2 id="new-title">{L('Новый холст', 'New canvas')}</h2>
            <NewCanvasForm
              onError={fail}
              onCreated={() => setDialog(null)}
              extra={
                <button type="button" onClick={() => setDialog(null)}>
                  {L('Отмена', 'Cancel')}
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

/** Модель выделения объектов: скачать, ход скачивания и загрузки, ошибка */
function SegmentBanner(props: { segment: StateDto['segment']; onError: (err: unknown) => void }) {
  const { segment } = props;
  const install = () => post('/api/segment/install').catch(props.onError);
  if (segment.status === 'downloading') return <div class="stage-banner">{L('Скачиваю модель…', 'Downloading model…')} {Math.round((segment.progress ?? 0) * 100)}%</div>;
  if (segment.status === 'loading') return <div class="stage-banner">{L('Загружаю модель…', 'Loading model…')}</div>;
  return (
    <div class={segment.status === 'error' ? 'stage-banner error' : 'stage-banner'}>
      {segment.status === 'error' ? short(segment.error ?? L('Ошибка', 'Error'), 80) : L('Нужна модель выделения, 272 МБ', 'Object selection model needed, 272 MB')}
      <Help>
        {L('Объекты выделяет SAM 2.1 от Meta — прямо на компьютере, без интернета и без генераций. Модель скачивается один раз в папку данных приложения.', 'Objects are selected by SAM 2.1 from Meta — right on your computer, offline and without generations. The model is downloaded once into the app data folder.')}
      </Help>
      <button onClick={install}>{segment.status === 'error' ? L('Повторить', 'Retry') : L('Скачать', 'Download')}</button>
    </div>
  );
}

type JobAction = 'discard' | 'retry' | 'more' | 'stop';

/** У задачи что-то идёт: законченные интерфейс убирает сам — их варианты уже версии слоёв */
function busyJob(job: JobDto): boolean {
  return (
    job.status === 'queued' ||
    job.status === 'preparing' ||
    job.status === 'running' ||
    !!job.chain ||
    job.variants.some((v) => v.status === 'running' || v.masking)
  );
}

/** Сколько плиток «идёт» у задачи: по одной на вариант в работе; пока вариантов нет — одна; маску рисуют на плитке версии */
function runningTiles(job: JobDto): number {
  if (!busyJob(job) || masksOnly(job)) return 0;
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

/** Строка дерева «Слоёв»: слой (его части из старых проектов — строками под ним) или группа со всем, что в ней */
type RowNode = { kind: 'layer'; o: ObjectDto } | { kind: 'group'; g: GroupDto; children: RowNode[] };

/**
 * Слои и группы сверху вниз — то же дерево, что на сервере (layer-tree.ts). Части слоя и заплатки фона из старых проектов —
 * не строки дерева; петли в группах (испорченный проект) обрываются в корне
 */
function layerTree(objects: ObjectDto[], groups: GroupDto[]): RowNode[] {
  const ids = new Set(objects.map((o) => o.id));
  const byId = new Map(groups.map((g) => [g.id, g]));
  const parentOf = (id: string): string | undefined => {
    const seen = new Set([id]);
    const p = byId.get(id)?.group;
    for (let cur = p; cur !== undefined; cur = byId.get(cur)?.group) {
      if (seen.has(cur) || !byId.has(cur)) return undefined;
      seen.add(cur);
    }
    return p;
  };
  const roots: RowNode[] = [];
  const made = new Map<string, Extract<RowNode, { kind: 'group' }>>();
  const childrenOf = (id: string): RowNode[] => {
    const known = made.get(id);
    if (known) return known.children;
    const node = { kind: 'group' as const, g: byId.get(id)!, children: [] as RowNode[] };
    made.set(id, node);
    const parent = parentOf(id);
    (parent ? childrenOf(parent) : roots).push(node);
    return node.children;
  };
  for (const o of [...objects].reverse()) {
    const attached = o.kind === 'fill' ? !!o.under && ids.has(o.under) : !!o.parent && ids.has(o.parent);
    if (!attached) (o.group && byId.has(o.group) ? childrenOf(o.group) : roots).push({ kind: 'layer', o });
  }
  return roots;
}

/** Куда ляжет перетаскиваемое: в группу into (null — в корень) прямо над over (null — под всеми в ней); at, where — где черта */
interface Drop {
  into: string | null;
  over: string | null;
  /** Строка, у которой черта; null — над фоном */
  at: string | null;
  where: 'above' | 'below' | 'into';
}

/**
 * Слои: строка — миниатюра того, что видно, имя и глаз; группы — папками, как в Photoshop: стрелка сворачивает, глаз скрывает
 * всё, что в ней. Генерация нового слоя — строкой сверху, пока слой не появится. Shift-щелчок — несколько слоёв; их действия —
 * в ленте под холстом. Строки перетаскивают выше, ниже и в группы; редкие действия — в «⋯» строки. Фон — внизу списка
 */
function LayersPanel(props: {
  doc: DocDto;
  objects: ObjectDto[];
  groups: GroupDto[];
  patches: PatchDto[];
  jobs: JobDto[];
  active: string | null;
  activeGroup: string | null;
  activeJob: string | null;
  /** Слои в выделении: Shift-щелчком в списке */
  picked: Set<string>;
  /** Слой, маску которого правят */
  maskLayer: string | null;
  onSelect: (o: ObjectDto, add: boolean) => void;
  /** Щелчок по миниатюре маски: кисть правит маску того, что от слоя видно */
  onMask: (o: ObjectDto) => void;
  /** Работать в слое, если ещё не в нём (двойной щелчок — переименовать) */
  onEnter: (o: ObjectDto) => void;
  onSelectGroup: (g: GroupDto, add: boolean) => void;
  onSelectJob: (job: JobDto) => void;
  onBackground: () => void;
  onHover: (o: ObjectDto | null) => void;
  onRename: (o: ObjectDto, name: string) => void;
  onRenameGroup: (g: GroupDto, name: string) => void;
  onHidden: (o: ObjectDto, hidden: boolean) => void;
  onGroupHidden: (g: GroupDto, hidden: boolean) => void;
  onFill: (o: ObjectDto) => void;
  onMergeDown: (o: ObjectDto) => void;
  onDelete: (o: ObjectDto) => void;
  onGroup: () => void;
  onMerge: () => void;
  onFlatten: () => void;
  onUngroup: (g: GroupDto) => void;
  onDeleteGroup: (g: GroupDto) => void;
  /** Слой или группу id — в группу into прямо над over */
  onMove: (id: string, into: string | null, over: string | null) => void;
  onJob: (job: JobDto, action: JobAction) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  /** Свёрнутые группы: только в этом окне, в документ не идут */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  /** Что перетаскивают и куда оно ляжет */
  const [drag, setDrag] = useState<{ id: string; drop: Drop | null } | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  /** Щелчок, которым кончилось перетаскивание, ничего не выбирает */
  const dragged = useRef(false);
  /** Скрыть просили у слоя-копии, под которым нет фона: сначала спросить */
  const [asking, setAsking] = useState<string | null>(null);
  const patches = new Map(props.patches.map((p) => [p.id, p]));
  const ids = new Set(props.objects.map((o) => o.id));
  // Части слоя из старых проектов — строками под ним
  const parts = new Map<string, ObjectDto[]>();
  for (const o of [...props.objects].reverse()) {
    if (o.kind !== 'fill' && o.parent && ids.has(o.parent)) parts.set(o.parent, [...(parts.get(o.parent) ?? []), o]);
  }
  const tree = layerTree(props.objects, props.groups);
  // Где каждый узел дерева: в какой группе, кто прямо под ним, первый в группе и что лежит в группе
  const place = new Map<string, { parent: string | null; next: string | null }>();
  const first = new Map<string, string>();
  const inside = new Map<string, Set<string>>();
  const index = (nodes: RowNode[], parent: string | null): string[] => {
    const all: string[] = [];
    nodes.forEach((n, i) => {
      const id = n.kind === 'layer' ? n.o.id : n.g.id;
      const below = nodes[i + 1];
      place.set(id, { parent, next: below ? (below.kind === 'layer' ? below.o.id : below.g.id) : null });
      all.push(id);
      if (n.kind === 'group') {
        const head = n.children[0];
        if (head) first.set(id, head.kind === 'layer' ? head.o.id : head.g.id);
        const nested = index(n.children, id);
        inside.set(id, new Set(nested));
        all.push(...nested);
      }
    });
    return all;
  };
  index(tree, null);
  const groupById = new Map(props.groups.map((g) => [g.id, g]));
  /** Группа видна: ни она, ни те, в которых она лежит, не скрыты */
  const groupShown = (id: string | undefined) => {
    for (let i = 0, g = id ? groupById.get(id) : undefined; g && i < 64; i++, g = g.group ? groupById.get(g.group) : undefined) if (g.hidden) return false;
    return true;
  };
  const thumb = (p: PatchDto | undefined) => p && `/api/history/${p.id}/thumb.png?doc=${props.doc.id}&m=${p.maskRev}`;
  const maskThumb = (p: PatchDto) => `/api/history/${p.id}/mask-thumb.png?doc=${props.doc.id}&m=${p.maskRev}`;
  // Генерации новых слоёв — пока слоя нет
  const pending = props.jobs.filter((j) => !j.object);
  // Слои стоят с отступом под стрелкой группы, когда группы есть: миниатюры одного уровня — в столбик
  const gutter = props.groups.length ? 22 : 4;

  // Слой, в который вошли щелчком на холсте, виден: группы, где он лежит, разворачиваются
  useEffect(() => {
    const o = props.objects.find((x) => x.id === props.active);
    const chain: string[] = [];
    for (let i = 0, g = o?.group ? groupById.get(o.group) : undefined; g && i < 64; i++, g = g.group ? groupById.get(g.group) : undefined) chain.push(g.id);
    if (chain.some((id) => collapsed.has(id))) setCollapsed((c) => new Set([...c].filter((id) => !chain.includes(id))));
  }, [props.active]);
  const toggle = (id: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  /** Куда ляжет перетаскиваемое при курсоре на высоте y: у группы середина строки — в неё, у слоя — над ним или под ним */
  const dropAt = (y: number): Drop => {
    for (const li of listRef.current?.querySelectorAll<HTMLElement>(':scope > li[data-node]') ?? []) {
      const r = li.querySelector('.layer-row')!.getBoundingClientRect();
      if (y > r.bottom) continue;
      const id = li.dataset.node!;
      const at = place.get(id) ?? { parent: null, next: null };
      const f = (y - r.top) / r.height;
      if (li.dataset.kind === 'group' && f >= 0.3 && (f < 0.7 || !collapsed.has(id))) return { into: id, over: first.get(id) ?? null, at: id, where: 'into' };
      if (f < 0.5) return { into: at.parent, over: id, at: id, where: 'above' };
      return { into: at.parent, over: at.next, at: id, where: 'below' };
    }
    return { into: null, over: null, at: null, where: 'above' };
  };
  /** Ляжет ли туда id: не в саму себя (группа) и не туда же, где лежит */
  const changes = (id: string, d: Drop) => {
    if (d.into !== null && (d.into === id || inside.get(id)?.has(d.into))) return false;
    const now = place.get(id);
    return d.over !== id && !(now && now.parent === d.into && now.next === d.over);
  };
  const startDrag = (e: PointerEvent, id: string) => {
    if (e.button !== 0 || (e.target as Element).closest('button, input')) return;
    const row = e.currentTarget as HTMLElement;
    const y0 = e.clientY;
    let moving = false;
    const move = (ev: PointerEvent) => {
      if (!moving && Math.abs(ev.clientY - y0) < 4) return;
      if (!moving) row.setPointerCapture(ev.pointerId);
      moving = true;
      // У края списка он прокручивается
      const list = listRef.current;
      if (list) {
        const r = list.getBoundingClientRect();
        if (ev.clientY < r.top + 32) list.scrollTop -= 12;
        else if (ev.clientY > r.bottom - 32) list.scrollTop += 12;
      }
      const d = dropAt(ev.clientY);
      setDrag({ id, drop: changes(id, d) ? d : null });
    };
    const end = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      if (!moving) return;
      setDrag(null);
      dragged.current = true;
      window.setTimeout(() => (dragged.current = false), 0);
      const d = dropAt(ev.clientY);
      if (ev.type === 'pointerup' && changes(id, d)) props.onMove(id, d.into, d.over);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };
  const dropClass = (id: string | null) => (drag?.drop && drag.drop.at === id ? `drop-${drag.drop.where}` : '');

  /**
   * Двойной щелчок — по строке первого щелчка, что бы ни оказалось под курсором ко второму: второй щелчок по слою, в котором
   * работают, вывел бы из него. Второй щелчок в той же точке вскоре — переименование
   */
  const armRename = (e: MouseEvent, start: () => void) => {
    const { clientX: x, clientY: y, timeStamp: t } = e;
    const second = (ev: MouseEvent) => {
      if (ev.detail < 2 || ev.timeStamp - t > 600 || Math.hypot(ev.clientX - x, ev.clientY - y) > 6) return;
      ev.preventDefault();
      ev.stopPropagation();
      stop();
      start();
    };
    const stop = () => {
      window.removeEventListener('click', second, true);
      window.clearTimeout(timer);
    };
    const timer = window.setTimeout(stop, 600);
    window.addEventListener('click', second, true);
  };

  const nameOrField = (id: string, name: string, done: (name: string) => void) =>
    editing === id ? (
      <RenameField
        value={name}
        onDone={(next) => {
          setEditing(null);
          if (next && next !== name) done(next);
        }}
      />
    ) : (
      <span class="layer-name">{name}</span>
    );

  const layerRow = (o: ObjectDto, depth: number, node: boolean): ComponentChildren => {
    const active = props.active === o.id;
    const busy = props.jobs.some((j) => (j.object === o.id || j.fillFor === o.id) && busyJob(j));
    const failed = props.jobs.some((j) => j.object === o.id && j.status === 'error');
    // Копия без фона: скрой её — под ней то же самое
    const needsFill = o.kind !== 'fill' && !o.freed && !o.current && !o.hidden;
    const filling = props.jobs.some((j) => j.fillFor === o.id && busyJob(j));
    // Что от слоя видно: у этой версии и маска; у исходника слоя из генерации маски нет
    const shown = o.kind !== 'fill' ? patches.get(o.current ?? o.layer ?? '') : undefined;
    const masking = props.maskLayer === o.id;
    return (
      <Fragment key={o.id}>
        <li
          class={[
            'layer',
            active ? 'active' : '',
            masking ? 'masking' : '',
            !active && props.picked.has(o.id) ? 'picked' : '',
            o.visible ? '' : 'off',
            o.lost ? 'lost' : '',
            drag?.id === o.id ? 'dragged' : '',
            dropClass(o.id),
          ]
            .filter(Boolean)
            .join(' ')}
          data-layer={o.id}
          data-node={node ? o.id : undefined}
          data-kind="layer"
          style={{ '--indent': `${gutter + depth * 18}px` }}
          onPointerEnter={() => props.onHover(o)}
          onPointerLeave={() => props.onHover(null)}
        >
          <div
            class="layer-row"
            style={{ paddingLeft: `${gutter + depth * 18}px` }}
            title={o.lost ? L('После правки слой не нашёлся: маска прежняя', 'The layer was not found after the edit: the mask is unchanged') : L('Работать в слое; Shift — к выделению; двойной щелчок — переименовать; перетащить — порядок', 'Work in the layer; Shift — add to selection; double-click — rename; drag — reorder')}
            onPointerDown={node && editing !== o.id ? (e) => startDrag(e, o.id) : undefined}
            onClick={(e) => {
              if (dragged.current || e.detail > 1) return;
              props.onSelect(o, e.metaKey || e.ctrlKey || e.shiftKey);
              armRename(e, () => {
                props.onEnter(o);
                setEditing(o.id);
              });
            }}
          >
            <span class="thumbs">
              <Thumb src={thumb(patches.get(o.current ?? o.layer ?? ''))} />
              {shown && (
                <button
                  class="thumb mask"
                  title={o.visible ? L('Маска: править кистью', 'Mask: edit with the brush') : L('Слой скрыт', 'Layer is hidden')}
                  aria-label={L('Маска слоя', 'Layer mask')}
                  aria-pressed={masking}
                  disabled={!o.visible}
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onMask(o);
                  }}
                >
                  <img src={maskThumb(shown)} alt="" draggable={false} />
                </button>
              )}
            </span>
            {nameOrField(o.id, o.name, (name) => props.onRename(o, name))}
            {busy && <IconLoader2 size={15} stroke={STROKE} class="spin layer-badge" aria-label={L('Идёт генерация', 'Generating')} />}
            {failed && !busy && <IconAlertTriangle size={15} stroke={STROKE} class="layer-badge error" aria-label={L('Генерация с ошибкой', 'Generation failed')} />}
            {o.freed && <IconPhoto size={14} stroke={STROKE} class="layer-badge" aria-label={L('Под ним уже нет его самого: вырезан или дорисован фон', 'It is no longer under itself: cut out, or the background is filled')} />}
            <MenuButton
              class="layer-icon layer-more"
              title={L('Действия со слоем', 'Layer actions')}
              label={<IconDots size={16} stroke={STROKE} />}
              items={[
                { icon: IconPencil, label: L('Переименовать', 'Rename'), hint: L('двойной щелчок', 'double-click'), run: () => (props.onEnter(o), setEditing(o.id)) },
                ...(o.kind !== 'fill'
                  ? [{ icon: IconBucketDroplet, label: L('Дорисовать фон под ним', 'Fill background under it'), hint: L('генерация', 'generation'), disabled: filling, title: L('В слоях, где под ним дыра, — их версиями; где только фон — новым слоем внизу', 'In layers with a hole under it — as their versions; where there is only background — as a new layer at the bottom'), run: () => props.onFill(o) }]
                  : []),
                { icon: IconArrowBarToDown, label: L('Влить в фон', 'Merge into background'), disabled: !o.visible, title: L('То, что от него видно, — в исходник', 'What is visible of it goes into the original'), run: () => props.onMergeDown(o) },
                'sep',
                { icon: IconTrash, label: o.freed ? L('Убрать с холста', 'Remove from canvas') : L('Удалить слой', 'Delete layer'), hint: L('⌘Z вернёт', '⌘Z brings it back'), danger: true, run: () => props.onDelete(o) },
              ]}
            />
            <button
              class="layer-icon"
              title={o.hidden ? L('Показать слой', 'Show layer') : L('Скрыть слой', 'Hide layer')}
              aria-label={L('Показывать слой', 'Show layer')}
              aria-pressed={!o.hidden}
              onClick={(e) => {
                e.stopPropagation();
                if (needsFill) setAsking(asking === o.id ? null : o.id);
                else props.onHidden(o, !o.hidden);
              }}
            >
              {o.hidden ? <IconEyeOff size={16} stroke={STROKE} /> : <IconEye size={16} stroke={STROKE} />}
            </button>
          </div>
          {asking === o.id && (
            <div class="layer-ask">
              {L('Под слоем то же самое: фона нет', 'Same thing under the layer: no background')}
              <button
                onClick={() => {
                  setAsking(null);
                  props.onFill(o);
                }}
              >
                {L('Дорисовать фон', 'Fill background')}
              </button>
              <button
                onClick={() => {
                  setAsking(null);
                  props.onHidden(o, true);
                }}
              >
                {L('Скрыть', 'Hide')}
              </button>
            </div>
          )}
        </li>
        {(parts.get(o.id) ?? []).map((c) => layerRow(c, depth + 1, false))}
      </Fragment>
    );
  };

  const groupRow = (n: Extract<RowNode, { kind: 'group' }>, depth: number): ComponentChildren => {
    const { g } = n;
    const open = !collapsed.has(g.id);
    const active = props.activeGroup === g.id;
    const Folder = open ? IconFolderOpen : IconFolder;
    const size = inside.get(g.id)?.size ?? 0;
    return (
      <Fragment key={g.id}>
        <li
          class={['layer', 'group', active ? 'active' : '', groupShown(g.id) ? '' : 'off', drag?.id === g.id ? 'dragged' : '', dropClass(g.id)].filter(Boolean).join(' ')}
          data-node={g.id}
          data-kind="group"
          style={{ '--indent': `${4 + depth * 18}px` }}
        >
          <div
            class="layer-row"
            style={{ paddingLeft: `${depth * 18}px` }}
            title={L('Группа: её слои в выделение, новый слой ляжет в неё; двойной щелчок — переименовать; перетащить — порядок', 'Group: its layers go into the selection, a new layer goes into it; double-click — rename; drag — reorder')}
            onPointerDown={editing !== g.id ? (e) => startDrag(e, g.id) : undefined}
            onClick={(e) => {
              if (dragged.current || e.detail > 1) return;
              props.onSelectGroup(g, e.metaKey || e.ctrlKey || e.shiftKey);
              armRename(e, () => setEditing(g.id));
            }}
          >
            <button
              class="layer-fold"
              title={open ? L('Свернуть', 'Collapse') : L('Развернуть', 'Expand')}
              aria-label={open ? L('Свернуть группу', 'Collapse group') : L('Развернуть группу', 'Expand group')}
              aria-expanded={open}
              onClick={(e) => {
                e.stopPropagation();
                toggle(g.id);
              }}
            >
              {open ? <IconChevronDown size={14} stroke={2} /> : <IconChevronRight size={14} stroke={2} />}
            </button>
            <span class="thumb folder">
              <Folder size={17} stroke={STROKE} aria-hidden="true" />
            </span>
            {nameOrField(g.id, g.name, (name) => props.onRenameGroup(g, name))}
            {!open && <span class="layer-count">{size}</span>}
            <MenuButton
              class="layer-icon layer-more"
              title={L('Действия с группой', 'Group actions')}
              label={<IconDots size={16} stroke={STROKE} />}
              items={[
                { icon: IconPencil, label: L('Переименовать', 'Rename'), hint: L('двойной щелчок', 'double-click'), run: () => setEditing(g.id) },
                { icon: IconStackPop, label: L('Разгруппировать', 'Ungroup'), hint: '⇧⌘G', title: L('Слои из неё — на её место', 'Its layers take its place'), run: () => props.onUngroup(g) },
                'sep',
                { icon: IconTrash, label: L('Удалить со слоями', 'Delete with layers'), hint: L('⌘Z вернёт', '⌘Z brings it back'), danger: true, run: () => props.onDeleteGroup(g) },
              ]}
            />
            <button
              class="layer-icon"
              title={g.hidden ? L('Показать группу', 'Show group') : L('Скрыть группу', 'Hide group')}
              aria-label={L('Показывать группу', 'Show group')}
              aria-pressed={!g.hidden}
              onClick={(e) => {
                e.stopPropagation();
                props.onGroupHidden(g, !g.hidden);
              }}
            >
              {g.hidden ? <IconEyeOff size={16} stroke={STROKE} /> : <IconEye size={16} stroke={STROKE} />}
            </button>
          </div>
        </li>
        {open && rows(n.children, depth + 1)}
      </Fragment>
    );
  };

  const rows = (nodes: RowNode[], depth: number): ComponentChildren[] => nodes.map((n) => (n.kind === 'layer' ? layerRow(n.o, depth, true) : groupRow(n, depth)));

  return (
    <section class="panel layers-panel">
      <h2 class="panel-head">
        {L('Слои', 'Layers')}
        <Help>
          {L('Слой — кусок картинки со своими пикселями поверх остального. Щелчок по слою здесь или палочкой на холсте — работа в нём: палочка ищет только в нём, генерация ложится его версией; его версии — в ленте под холстом. Щелчок по маске рядом — кисть правит её, щелчок по слою — снова его пиксели. Фон внизу — работа вне слоёв: генерация ляжет новым слоем. ⌘J — копия выделенного новым слоем, ⌘⇧J — вырезать. Shift-щелчок — несколько слоёв: ⌘G их группирует, ⌘E объединяет. Группа: щелчок — её слои в выделение, новый слой ляжет в неё; стрелка сворачивает, глаз скрывает всё, что в ней, ⇧⌘G разгруппировывает. Перетащите слой или группу выше, ниже или в группу. «\\» — исходник всей картинки, пока держите.', 'A layer is a piece of the picture with its own pixels on top of the rest. Click a layer here, or click it with the wand on the canvas, to work in it: the wand searches only inside it, and a generation becomes its version; its versions are in the strip under the canvas. Click the mask next to it to edit the mask with the brush; click the layer to get back to its pixels. Background at the bottom — work outside layers: a generation becomes a new layer. ⌘J copies the selection to a new layer, ⌘⇧J cuts it. Shift-click selects several layers: ⌘G groups them, ⌘E merges them. Group: a click puts its layers into the selection, and a new layer goes into it; the arrow collapses it, the eye hides everything in it, ⇧⌘G ungroups. Drag a layer or a group above, below or into a group. “\\” shows the original of the whole picture while held.')}
        </Help>
        <span class="grow" />
        <button class="ghost small head-button" title={L('Сгруппировать выбранное (⌘G)', 'Group selected (⌘G)')} onClick={props.onGroup}>
          <IconFolderPlus size={15} stroke={STROKE} aria-hidden="true" />
          {L('Группа', 'Group')}
        </button>
        <MenuButton
          class="ghost icon head-more"
          title={L('Ещё', 'More')}
          label={<IconDots size={16} stroke={STROKE} />}
          items={[
            { icon: IconLayersUnion, label: L('Объединить выбранные', 'Merge selected'), hint: '⌘E', run: props.onMerge },
            'sep',
            { icon: IconArrowBarToDown, label: L('Свести все слои', 'Flatten All Layers'), title: L('Всё видимое — в исходник, слои уходят; ⌘Z вернёт', 'Everything visible goes into the original, layers go away; ⌘Z brings them back'), run: props.onFlatten },
          ]}
        />
      </h2>
      <ol class={drag ? 'layers dragging' : 'layers'} ref={listRef}>
        {pending.map((j) => {
          const error = j.status === 'error';
          return (
            <li class={['layer', 'pending', error ? 'error' : '', props.activeJob === j.id ? 'active' : ''].filter(Boolean).join(' ')} key={j.id}>
              <div class="layer-row" style={{ paddingLeft: `${gutter}px` }} title={error ? j.error : L('Генерация нового слоя', 'Generating a new layer')} onClick={() => props.onSelectJob(j)}>
                <Thumb icon={error ? IconAlertTriangle : IconLoader2} spin={!error} />
                <span class="layer-name">{j.fillFor ? L(`Фон под «${props.objects.find((o) => o.id === j.fillFor)?.name ?? '…'}»`, `Background under “${props.objects.find((o) => o.id === j.fillFor)?.name ?? '…'}”`) : j.prompt}</span>
                <span class="layer-count">{error ? L('ошибка', 'error') : clock(Date.now() - Date.parse(j.createdAt))}</span>
                <button
                  class="layer-icon"
                  title={error ? L('Убрать', 'Dismiss') : L('Отменить генерацию', 'Cancel generation')}
                  aria-label={error ? L('Убрать', 'Dismiss') : L('Отменить генерацию', 'Cancel generation')}
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onJob(j, 'discard');
                  }}
                >
                  <IconX size={15} stroke={STROKE} />
                </button>
              </div>
            </li>
          );
        })}
        {rows(tree, 0)}
        {/* Фон выбран, когда работают не в слое, не в группе и не в генерации и слоёв в выделении нет: генерация ляжет новым слоем */}
        <li
          class={['layer', 'background', !props.active && !props.activeGroup && !props.activeJob && !props.picked.size ? 'active' : '', dropClass(null)]
            .filter(Boolean)
            .join(' ')}
        >
          <div class="layer-row" style={{ paddingLeft: `${gutter}px` }} title={L('Работать на фоне: правка — новым слоем', 'Work on the background: an edit becomes a new layer')} onClick={props.onBackground}>
            <Thumb src={`/api/doc/base/${props.doc.levels - 1}/0/0.jpg?doc=${props.doc.id}&base=${props.doc.baseState}`} />
            <span class="layer-name">{L('Фон', 'Background')}</span>
          </div>
        </li>
      </ol>
    </section>
  );
}

type BandTab = 'task' | 'directed' | 'critique';

/**
 * Лента под холстом — картинки того, во что ляжет правка: версии слоя (наведение показывает версию на холсте, щелчок делает
 * её текущей), ход и ошибки его генераций и то, что о версии сказали директор и критик; у генерации нового слоя — её ход; у
 * фона — недавние версии всех слоёв; у группы и нескольких слоёв — их действия. Высота постоянная: выбор ничего не сдвигает
 */
function VersionsBand(props: {
  doc: DocDto;
  objects: ObjectDto[];
  groups: GroupDto[];
  patches: PatchDto[];
  jobs: JobDto[];
  active: ObjectDto | undefined;
  group: GroupDto | undefined;
  /** Слои, выбранные Shift-щелчком, — когда их два и больше */
  picked: ObjectDto[];
  job: JobDto | undefined;
  errorJob: string | null;
  maskLayer: string | null;
  folded: boolean;
  focused: boolean;
  variants: number;
  steps: number;
  onFold: () => void;
  onFocus: () => void;
  /** Навели на версию слоя (patch null — исходник); o null — увели */
  onPeek: (o: ObjectDto | null, patch?: string | null) => void;
  onCurrent: (o: ObjectDto, patch: string | null) => void;
  onEnter: (o: ObjectDto) => void;
  onError: (job: string | null) => void;
  onMore: (patch: PatchDto) => void;
  onRedo: (patch: PatchDto) => void;
  onObjectMask: (patch: PatchDto) => void;
  onExpand: (patch: PatchDto) => void;
  onDeleteVersion: (patch: PatchDto) => void;
  onJob: (job: JobDto, action: JobAction) => void;
  onGroup: () => void;
  onMerge: () => void;
  onUngroup: (g: GroupDto) => void;
  onDeleteGroup: (g: GroupDto) => void;
}) {
  const [tab, setTab] = useState<BandTab>('task');
  const o = props.active;
  useEffect(() => setTab('task'), [o?.id, o?.current]);
  const patches = new Map(props.patches.map((p) => [p.id, p]));
  const thumb = (p: PatchDto) => `/api/history/${p.id}/thumb.png?doc=${props.doc.id}&m=${p.maskRev}`;
  const since = (j: JobDto) => clock(Date.now() - Date.parse(j.createdAt));
  const leave = () => props.onPeek(null);
  /** Плитка идущей генерации; у первой плитки задачи — «Остановить» (шаги) и «Отменить» */
  const spinner = (j: JobDto, i: number, controls: boolean) => (
    <span key={`${j.id}:${i}`} class="vt wait" title={`${jobStatus(j)}, ${since(j)}`}>
      <span class="vt-cover">
        <IconLoader2 size={18} stroke={STROKE} class="spin" aria-hidden="true" />
        <span>{jobStatus(j)}</span>
      </span>
      {controls && i === 0 && (
        <span class="vt-ctl">
          {j.chain && (
            <button title={L('Остановить: готовые шаги останутся версиями', 'Stop: finished steps stay as versions')} aria-label={L('Остановить', 'Stop')} onClick={() => props.onJob(j, 'stop')}>
              <IconPlayerStop size={13} stroke={2} />
            </button>
          )}
          <button title={L('Отменить: готовое останется версиями', 'Cancel: finished ones stay as versions')} aria-label={L('Отменить', 'Cancel')} onClick={() => props.onJob(j, 'discard')}>
            <IconX size={13} stroke={2} />
          </button>
        </span>
      )}
    </span>
  );

  let head: ComponentChildren;
  let tiles: ComponentChildren = null;
  let text: ComponentChildren = null;

  if (props.picked.length > 1) {
    const n = props.picked.length;
    head = (
      <>
        <strong>
          {n} {plural(n, ['слой', 'слоя', 'слоёв'], ['layer', 'layers'])}
        </strong>
        <span class="band-meta">{props.picked.map((x) => x.name).join(', ')}</span>
        <span class="grow" />
        <button class="bbtn" title={L('В новую группу (⌘G)', 'Into a new group (⌘G)')} onClick={props.onGroup}>
          <IconFolderPlus size={15} stroke={STROKE} aria-hidden="true" />
          {L('Сгруппировать', 'Group')}
        </button>
        <button class="bbtn" title={L('Одним слоем из того, что сейчас видно; версии уйдут (⌘E)', 'One layer from what is visible now; versions go away (⌘E)')} onClick={props.onMerge}>
          <IconLayersUnion size={15} stroke={STROKE} aria-hidden="true" />
          {L('Объединить', 'Merge')}
        </button>
      </>
    );
  } else if (props.job) {
    const j = props.job;
    const error = j.status === 'error';
    const name = j.fillFor ? L(`Фон под «${props.objects.find((x) => x.id === j.fillFor)?.name ?? '…'}»`, `Background under “${props.objects.find((x) => x.id === j.fillFor)?.name ?? '…'}”`) : j.prompt;
    head = (
      <>
        <strong>{short(name, 48)}</strong>
        <span class="band-meta">{L('новый слой ·', 'new layer ·')} {error ? L('ошибка', 'error') : `${jobStatus(j)}, ${since(j)}`}</span>
        <span class="grow" />
        {error ? (
          <>
            <button class="bbtn" onClick={() => props.onJob(j, j.inside ? 'more' : 'retry')}>
              <IconRefresh size={15} stroke={STROKE} aria-hidden="true" />
              {L('Повторить', 'Retry')}
            </button>
            <button class="bicon" title={L('Убрать', 'Dismiss')} aria-label={L('Убрать', 'Dismiss')} onClick={() => props.onJob(j, 'discard')}>
              <IconTrash size={16} stroke={STROKE} />
            </button>
          </>
        ) : (
          <>
            {j.chain && (
              <button class="bbtn" title={L('Готовые шаги останутся версиями', 'Finished steps stay as versions')} onClick={() => props.onJob(j, 'stop')}>
                <IconPlayerStop size={15} stroke={STROKE} aria-hidden="true" />
                {L('Остановить', 'Stop')}
              </button>
            )}
            <button class="bbtn" title={L('Готовые варианты останутся версиями', 'Finished variants stay as versions')} onClick={() => props.onJob(j, 'discard')}>
              <IconX size={15} stroke={STROKE} aria-hidden="true" />
              {L('Отменить', 'Cancel')}
            </button>
          </>
        )}
      </>
    );
    tiles = error ? (
      <span class="vt err on">
        <span class="vt-cover">
          <IconAlertTriangle size={18} stroke={STROKE} aria-hidden="true" />
          <span>{L('ошибка', 'error')}</span>
        </span>
      </span>
    ) : (
      Array.from({ length: runningTiles(j) || 1 }, (_, i) => spinner(j, i, false))
    );
    text = (
      <>
        {error && <p class="band-para err">{j.error}</p>}
        <p class="band-para">{j.prompt}</p>
      </>
    );
  } else if (props.group) {
    const g = props.group;
    const byId = new Map(props.groups.map((x) => [x.id, x]));
    const within = (x: ObjectDto) => {
      for (let i = 0, id = x.group; id && i < 64; i++, id = byId.get(id)?.group) if (id === g.id) return true;
      return false;
    };
    const n = props.objects.filter((x) => x.kind !== 'fill' && within(x)).length;
    head = (
      <>
        <strong>{g.name}</strong>
        <span class="band-meta">
          {L('группа ·', 'group ·')} {n} {plural(n, ['слой', 'слоя', 'слоёв'], ['layer', 'layers'])}
          {g.hidden ? L(' · скрыта', ' · hidden') : ''}
        </span>
        <span class="grow" />
        <button class="bbtn" title={L('Слои из неё — на её место (⇧⌘G)', 'Its layers take its place (⇧⌘G)')} onClick={() => props.onUngroup(g)}>
          <IconStackPop size={15} stroke={STROKE} aria-hidden="true" />
          {L('Разгруппировать', 'Ungroup')}
        </button>
        <button class="bicon" title={L('Удалить группу со слоями; ⌘Z вернёт', 'Delete the group with its layers; ⌘Z brings it back')} aria-label={L('Удалить группу со слоями', 'Delete the group with its layers')} onClick={() => props.onDeleteGroup(g)}>
          <IconTrash size={16} stroke={STROKE} />
        </button>
      </>
    );
  } else if (o) {
    const current = o.current ? patches.get(o.current) : undefined;
    const source = o.layer ? patches.get(o.layer) : undefined;
    // Что видно от слоя: текущая версия, без неё — его копия (исходник слоя-копии); у слоя из генерации исходник — то, что под ним
    const shown = current ?? source;
    const jobs = props.jobs.filter((j) => j.object === o.id);
    // Фон под этим слоем дорисовывается в других слоях: здесь — только ход
    const fillJobs = props.jobs.filter((j) => j.fillFor === o.id && j.object !== o.id);
    // Что про вариант знает задача, пока она есть: правка почти не случилась, модель рисует маску по объекту
    const weak = new Set(props.jobs.flatMap((j) => j.variants.flatMap((v) => (v.patch && v.insideChangedPct !== undefined && v.insideChangedPct < 2 ? [v.patch] : []))));
    const masking = new Set(props.jobs.flatMap((j) => j.variants.flatMap((v) => (v.patch && v.masking ? [v.patch] : []))));
    const failed = jobs.filter((j) => j.status === 'error');
    const err = failed.find((j) => j.id === props.errorJob);
    const fill = props.objects.find((x) => x.kind === 'fill' && x.under === o.id);
    const off = !o.visible;
    const n = current ? o.versions.indexOf(current.id) + 1 : 0;
    const meta = [
      current ? L(`версия ${n} из ${o.versions.length}`, `version ${n} of ${o.versions.length}`) : L('исходник', 'original'),
      current?.model && modelInfo(current.model).label,
      off && (o.hidden ? L('скрыт', 'hidden') : L('группа скрыта', 'group is hidden')),
    ].filter(Boolean);
    const vtile = (owner: ObjectDto, key: string, p: PatchDto | undefined, label: string, patch: string | null, title: string) => {
      const on = (owner.current ?? null) === patch;
      return (
        <button
          key={key}
          class={on ? 'vt on' : 'vt'}
          aria-pressed={on}
          title={title}
          onClick={() => props.onCurrent(owner, patch)}
          onDblClick={() => !props.focused && props.onFocus()}
          onPointerEnter={() => props.onPeek(owner, patch)}
          onPointerLeave={leave}
        >
          {p ? (
            <img src={thumb(p)} alt="" draggable={false} />
          ) : (
            <span class="vt-cover">
              <IconPhoto size={18} stroke={STROKE} aria-hidden="true" />
            </span>
          )}
          <span class="vt-n">{label}</span>
          {p && weak.has(p.id) && (
            <span class="vt-weak" title={L('Модель почти ничего не изменила', 'The model barely changed anything')}>
              {L('мало', 'low')}
            </span>
          )}
          {p && masking.has(p.id) && (
            <span class="vt-cover dim" title={L('Модель рисует маску по объекту', 'The model is drawing an object mask')}>
              <IconLoader2 size={18} stroke={STROKE} class="spin" aria-hidden="true" />
              <span>{L('маска', 'mask')}</span>
            </span>
          )}
        </button>
      );
    };
    head = (
      <>
        <strong>{o.name}</strong>
        <span class="band-meta">{meta.join(' · ')}</span>
        <span class="grow" />
        {err ? (
          <>
            <button class="bbtn" disabled={off} title={off ? L('Слой скрыт', 'Layer is hidden') : undefined} onClick={() => props.onJob(err, err.inside ? 'more' : 'retry')}>
              <IconRefresh size={15} stroke={STROKE} aria-hidden="true" />
              {L('Повторить', 'Retry')}
            </button>
            <button class="bicon" title={L('Убрать', 'Dismiss')} aria-label={L('Убрать', 'Dismiss')} onClick={() => props.onJob(err, 'discard')}>
              <IconTrash size={16} stroke={STROKE} />
            </button>
          </>
        ) : (
          <>
            <button class={props.focused ? 'bicon on' : 'bicon'} title={props.focused ? L('Вся картинка (F)', 'Whole picture (F)') : L('К куску (F)', 'Zoom to crop (F)')} aria-label={L('К куску', 'Zoom to crop')} onClick={props.onFocus}>
              {props.focused ? <IconZoomOut size={16} stroke={STROKE} /> : <IconZoomIn size={16} stroke={STROKE} />}
            </button>
            {shown && (
              <MenuButton
                class={props.maskLayer === o.id ? 'bbtn on' : 'bbtn'}
                title={off ? L('Слой скрыт', 'Layer is hidden') : L('Маска того, что видно', 'Mask of what is visible')}
                disabled={off}
                label={
                  <>
                    <IconMask size={15} stroke={STROKE} aria-hidden="true" />
                    {L('Маска', 'Mask')}
                    <IconChevronDown size={14} stroke={2} aria-hidden="true" />
                  </>
                }
                items={[
                  { icon: IconSparkles, label: L('По объекту', 'By object'), hint: L('генерация', 'generation'), disabled: masking.has(shown.id), title: L('Маску рисует модель из правки', 'The mask is drawn by the model from the edit panel'), run: () => props.onObjectMask(shown) },
                  ...(current
                    ? [{ icon: IconArrowsMaximize, label: L('По правке', 'By edit'), hint: L('без генерации', 'no generation'), title: L('Добавить к маске то, что модель нарисовала за её краем', 'Add to the mask what the model drew beyond its edge'), run: () => props.onExpand(current) }]
                    : []),
                ]}
              />
            )}
            {current && (
              <button class="bbtn" disabled={off} title={off ? L('Слой скрыт', 'Layer is hidden') : L('Задача этой версии — в поле правки', 'Put this version’s task into the edit field')} onClick={() => props.onRedo(current)}>
                <IconPencil size={15} stroke={STROKE} aria-hidden="true" />
                {L('Поправить задачу', 'Revise task')}
              </button>
            )}
            {current && (
              <button class="bicon" title={L('Удалить версию; ⌘Z вернёт', 'Delete version; ⌘Z brings it back')} aria-label={L('Удалить версию', 'Delete version')} onClick={() => props.onDeleteVersion(current)}>
                <IconTrash size={16} stroke={STROKE} />
              </button>
            )}
          </>
        )}
      </>
    );
    const more = current && !jobs.some(busyJob) && o.visible;
    const moreCount = current?.directed !== undefined ? props.steps : props.variants;
    tiles = (
      <>
        {vtile(o, 'src', source, L('исх', 'orig'), null, source ? L('Исходник слоя: копия того, что было видно', 'Layer original: a copy of what was visible') : L('Исходник: то, что под слоем', 'Original: what is under the layer'))}
        {o.versions.map((id, i) => {
          const p = patches.get(id);
          return vtile(o, id, p, String(i + 1), id, p?.prompt ?? '');
        })}
        {jobs.filter(busyJob).flatMap((j) => Array.from({ length: runningTiles(j) }, (_, i) => spinner(j, i, true)))}
        {failed.map((j) => (
          <button key={j.id} class={j === err ? 'vt err on' : 'vt err'} title={j.error} onClick={() => props.onError(j === err ? null : j.id)}>
            <span class="vt-cover">
              <IconAlertTriangle size={18} stroke={STROKE} aria-hidden="true" />
              <span>{L('ошибка', 'error')}</span>
            </span>
          </button>
        ))}
        {more && (
          <button
            class="vt add"
            title={L(`Ещё ${countText(current.directed !== undefined, moreCount)} с задачей версии ${n}`, `Another ${countText(current.directed !== undefined, moreCount)} with the task of version ${n}`)}
            aria-label={L('Ещё варианты', 'More variants')}
            onClick={() => props.onMore(current)}
          >
            <IconPlus size={18} stroke={STROKE} aria-hidden="true" />
            <span>{L('Ещё', 'More')}</span>
          </button>
        )}
        {/* Заплатка фона из проектов, где фон дорисовывали под слоем отдельно */}
        {fill && (
          <>
            <span class="vt-sep">{L('фон', 'background')}</span>
            {fill.versions.map((id, i) => vtile(fill, id, patches.get(id), String(i + 1), id, L('Вариант фона под слоем', 'Background variant under the layer')))}
          </>
        )}
      </>
    );
    const fillLines = fillJobs.map((j) => (
      <p class="band-line" key={j.id}>
        {j.status === 'error' ? <span class="err">{L('Фон под ним:', 'Background under it:')} {j.error}</span> : <span>{L('Фон под ним:', 'Background under it:')} {`${jobStatus(j)}, ${since(j)}`}</span>}
        {j.status === 'error' && (
          <button class="link" onClick={() => props.onJob(j, j.inside ? 'more' : 'retry')}>
            {L('Повторить', 'Retry')}
          </button>
        )}
        <button class="link" onClick={() => props.onJob(j, 'discard')}>
          {j.status === 'error' ? L('Убрать', 'Dismiss') : L('Отменить', 'Cancel')}
        </button>
      </p>
    ));
    if (err) {
      text = (
        <>
          {fillLines}
          <p class="band-para err">{err.error}</p>
          <p class="band-para">{err.prompt}</p>
        </>
      );
    } else if (current) {
      const tabs: [BandTab, string, string][] = [['task', L('Задача', 'Task'), current.prompt]];
      if (current.directed) tabs.push(['directed', L('Директор', 'Director'), current.directed]);
      if (current.critique) tabs.push(['critique', current.critique.done ? L('Критик: готово', 'Critic: done') : L('Критик', 'Critic'), current.critique.text]);
      const shownTab = tabs.find((t) => t[0] === tab) ?? tabs[0]!;
      text = (
        <>
          {fillLines}
          {tabs.length > 1 && (
            <div class="band-tabs" role="tablist">
              {tabs.map(([k, label]) => (
                <button key={k} role="tab" aria-selected={k === shownTab[0]} class={k === shownTab[0] ? 'on' : ''} onClick={() => setTab(k)}>
                  {label}
                </button>
              ))}
            </div>
          )}
          <p class="band-para">{shownTab[2]}</p>
          {shownTab[0] === 'task' && weak.has(current.id) && (
            <p class="band-para warn">
              {L('Модель почти ничего не изменила', 'The model barely changed anything')}
              <Help>{L('Опишите, что должно получиться, а не что исправить, или выделите область поменьше.', 'Describe what should appear, not what to fix, or select a smaller area.')}</Help>
            </p>
          )}
        </>
      );
    } else if (fillLines.length) text = <>{fillLines}</>;
  } else {
    // Фон: недавние версии всех слоёв — щелчок открывает слой, наведение показывает версию на холсте
    const owner = new Map<string, ObjectDto>();
    for (const x of props.objects) if (x.kind !== 'fill') for (const v of x.versions) owner.set(v, x);
    const recent = props.patches
      .filter((p) => owner.has(p.id))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, 16);
    head = (
      <>
        <strong>{L('Фон', 'Background')}</strong>
        <span class="band-meta">{recent.length ? L('недавние версии', 'recent versions') : L('исходник', 'original')}</span>
      </>
    );
    tiles = recent.map((p) => {
      const x = owner.get(p.id)!;
      return (
        <button key={p.id} class="vt" title={`${x.name}: ${p.prompt}`} onClick={() => props.onEnter(x)} onPointerEnter={() => props.onPeek(x, p.id)} onPointerLeave={leave}>
          <img src={thumb(p)} alt="" draggable={false} />
        </button>
      );
    });
  }

  return (
    <section class={props.folded ? 'band folded' : 'band'} aria-label={L('Версии', 'Versions')}>
      <div class="band-head">
        <button class="bicon band-fold" title={props.folded ? L('Развернуть ленту', 'Expand strip') : L('Свернуть ленту', 'Collapse strip')} aria-label={props.folded ? L('Развернуть ленту', 'Expand strip') : L('Свернуть ленту', 'Collapse strip')} onClick={props.onFold}>
          {props.folded ? <IconChevronRight size={15} stroke={2} /> : <IconChevronDown size={15} stroke={2} />}
        </button>
        {head}
      </div>
      {!props.folded && (
        <div class={text ? 'band-body' : 'band-body solo'}>
          <div class="band-tiles" onPointerLeave={leave}>
            {tiles}
          </div>
          {text && <div class="band-text">{text}</div>}
        </div>
      )}
    </section>
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
      aria-label={L('Имя объекта', 'Object name')}
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

/** Флажок правки: квадратик и подпись, пояснение — во всплывающей подсказке */
function Toggle(props: { label: string; title: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label class={props.checked ? 'toggle on' : 'toggle'} title={props.title}>
      <input type="checkbox" checked={props.checked} disabled={props.disabled} onChange={(e) => props.onChange(e.currentTarget.checked)} />
      {props.label}
    </label>
  );
}

/**
 * Всплывающее окно у кнопки: в body и fixed, под ней или, если внизу тесно, над ней; щелчок мимо или Esc закрывают.
 * Подсказка «?» внутри открывается своим окном, и щелчок по нему это окно не закрывает
 */
function Popover(props: { anchor: HTMLElement; class?: string; onClose: () => void; children: ComponentChildren }) {
  const pop = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const close = useRef(props.onClose);
  close.current = props.onClose;
  useLayoutEffect(() => {
    if (!pop.current) return;
    const a = props.anchor.getBoundingClientRect();
    const { width, height } = pop.current.getBoundingClientRect();
    const left = Math.min(Math.max(8, a.left), window.innerWidth - width - 8);
    const below = a.bottom + 4;
    setPos({ left, top: below + height > window.innerHeight - 8 ? Math.max(8, a.top - height - 4) : below });
  }, []);
  useEffect(() => {
    const away = (e: Event) => {
      const t = e.target as Element;
      if (!pop.current?.contains(t) && !props.anchor.contains(t) && !t.closest?.('.help-pop')) close.current();
    };
    // Esc закрывает окно и дальше не идёт: иначе он сбросил бы выделение
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close.current();
    };
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', esc, true);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', esc, true);
    };
  }, []);
  return createPortal(
    <div ref={pop} class={props.class ? `pop ${props.class}` : 'pop'} style={pos ? { left: `${pos.left}px`, top: `${pos.top}px` } : { visibility: 'hidden' }}>
      {props.children}
    </div>,
    document.body,
  );
}

type MenuItem = { icon: Icon; label: string; hint?: string; title?: string; danger?: boolean; disabled?: boolean; run: () => void } | 'sep';

/** Кнопка с меню действий: пункт — значок, подпись и справа мелко — сочетание клавиш или «генерация» */
function MenuButton(props: { class: string; title: string; label: ComponentChildren; disabled?: boolean; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={ref}
        class={open ? `${props.class} open` : props.class}
        title={props.title}
        aria-label={props.title}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={props.disabled}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        {props.label}
      </button>
      {open && ref.current && (
        <Popover anchor={ref.current} class="menu" onClose={() => setOpen(false)}>
          <div role="menu">
            {props.items.map((item, i) =>
              item === 'sep' ? (
                <hr key={i} />
              ) : (
                <button
                  key={i}
                  role="menuitem"
                  class={item.danger ? 'mi danger' : 'mi'}
                  title={item.title}
                  disabled={item.disabled}
                  onClick={() => {
                    setOpen(false);
                    item.run();
                  }}
                >
                  <item.icon size={16} stroke={STROKE} aria-hidden="true" />
                  {item.label}
                  {item.hint && <small>{item.hint}</small>}
                </button>
              ),
            )}
          </div>
        </Popover>
      )}
    </>
  );
}

/**
 * Модель и разрешение одной строкой-сводкой над кнопкой генерации; по щелчку — список моделей, разрешение и хватает ли его
 * куску. Мало разрешения — сводка жёлтая. У поправки версии — модель версии, сводка не открывается
 */
function ModelPicker(props: {
  model: ModelChoice;
  size: SizeChoice;
  sizes: string[];
  advice: SizeAdvice | string | null;
  locked: boolean;
  hasKey: boolean;
  service: GeminiService;
  onModel: (model: ModelChoice) => void;
  onSize: (size: SizeChoice) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const { advice } = props;
  const warn = !props.locked && (typeof advice === 'string' || !!(advice && advice.tooSmall));
  const res = props.model === 'chatgpt' ? L('1,6 Мп', '1.6 MP') : props.size === 'auto' ? L('авто', 'auto') : props.size;
  const title = props.locked
    ? L('Модель и разрешение — как у версии', 'Model and resolution — same as the version')
    : typeof advice === 'string'
      ? advice
      : advice
        ? L(`Кусок ${advice.frame.rect.width}×${advice.frame.rect.height} → ответ ${advice.output.width}×${advice.output.height}`, `Crop ${advice.frame.rect.width}×${advice.frame.rect.height} → output ${advice.output.width}×${advice.output.height}`)
        : L('Модель и разрешение', 'Model and resolution');
  const Glyph = warn ? IconAlertTriangle : IconAdjustmentsHorizontal;
  return (
    <>
      <button ref={ref} class={warn ? 'sum warn' : 'sum'} title={title} disabled={props.locked} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Glyph size={15} stroke={STROKE} aria-hidden="true" />
        <span>
          {modelInfo(props.model).short}
          {props.locked ? '' : ` · ${res}`}
          {warn ? L(' · мало', ' · low') : ''}
        </span>
        {props.locked ? <IconLock size={14} stroke={STROKE} aria-hidden="true" /> : <IconChevronDown size={14} stroke={2} aria-hidden="true" />}
      </button>
      {open && ref.current && (
        <Popover anchor={ref.current} class="settings-pop" onClose={() => setOpen(false)}>
          <div class="pop-label">{L('Модель', 'Model')}</div>
          {MODELS.map((m) => (
            <button key={m.id} class={props.model === m.id ? 'radio on' : 'radio'} role="radio" aria-checked={props.model === m.id} onClick={() => props.onModel(m.id)}>
              <span class="radio-dot" />
              <span class="radio-text">
                {m.label}
                <small>{!needsKey(m.id) ? m.note : props.hasKey ? [keyName(props.service), m.note].filter(Boolean).join(', ') : keyNeeded(props.service)}</small>
              </span>
            </button>
          ))}
          {props.model === 'chatgpt' ? (
            <p class="pop-note">{L('Разрешение ответа ChatGPT выбирает сам: около 1,6 Мп', 'ChatGPT picks the output resolution itself: about 1.6 MP')}</p>
          ) : (
            <>
              <div class="pop-label">{L('Разрешение', 'Resolution')}</div>
              <div class="pop-row">
                <Seg
                  label={L('Разрешение', 'Resolution')}
                  value={props.size}
                  options={SIZES.map((s) => ({ value: s, text: s === 'auto' ? L('Авто', 'Auto') : s, title: s === 'auto' ? L('Авто, до 2K', 'Auto, up to 2K') : s === '4K' ? L('4K, 4–5 минут', '4K, 4–5 minutes') : s }))}
                  onChange={props.onSize}
                />
              </div>
            </>
          )}
          {typeof advice === 'string' && <p class="job-warning pop-note">{advice}</p>}
          {advice && typeof advice === 'object' && (
            <div class="pop-advice">
              <SizeHint advice={advice} auto={props.size === 'auto'} sizes={props.sizes} onSize={props.onSize} />
            </div>
          )}
        </Popover>
      )}
    </>
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
        aria-label={L('Подсказка', 'Hint')}
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

/** Хватает ли куску разрешения ответа: мало — размоется, много — лишнее ожидание без новых деталей */
function SizeHint(props: { advice: SizeAdvice; auto: boolean; sizes: string[]; onSize: (size: SizeChoice) => void }) {
  const { frame, imageSize, output, scale, enough } = props.advice;
  const piece = `${frame.rect.width}×${frame.rect.height}`;
  const label = props.auto ? L(`авто (${imageSize})`, `auto (${imageSize})`) : imageSize;
  const slow = (size: string) => (size === '4K' ? L(', но идёт 4–5 минут', ', but takes 4–5 minutes') : '');
  const pick = (size: string) => (
    <button class="small" onClick={() => props.onSize(size as SizeChoice)}>
      {L('Поставить', 'Use')} {size}
    </button>
  );
  if (props.advice.tooSmall) {
    const better = props.sizes.indexOf(enough) > props.sizes.indexOf(imageSize) ? enough : null;
    return (
      <div class="size-hint warn">
        <p>
          {L('Мало разрешения: детали упадут в', 'Not enough resolution: detail drops')} {decimal(scale, 1)} {L('раза', 'times')}
          <Help>
            {L('Кусок с контекстом', 'The crop with context is')} {piece}{L(', а', ', and')} {label} {L('вернёт', 'returns')} {output.width}×{output.height}.{' '}
            {!better
              ? L('Это наибольшее разрешение модели: выделите область поменьше или правьте её по частям.', 'This is the highest resolution of the model: select a smaller area or edit it in parts.')
              : props.advice.beyond
                ? L(`Даже ${better} будет мало${slow(better)}: лучше выделить область поменьше.`, `Even ${better} will not be enough${slow(better)}: better select a smaller area.`)
                : L(`Хватит ${better}${slow(better)}.`, `${better} is enough${slow(better)}.`)}
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
          {L(`С запасом: хватит ${enough}`, `More than needed: ${enough} is enough`)}
          <Help>
            {L('Кусок', 'The crop is')} {piece}. {label} {L('не добавит деталей — ответ всё равно уменьшится до размера куска', 'won’t add detail — the output is downscaled to the crop size anyway')}{imageSize === '4K' ? L(', а ждать его 4–5 минут', ', and takes 4–5 minutes') : ''}.
          </Help>
        </p>
        {pick(enough)}
      </div>
    );
  }
  return (
    <p class="hint size-hint" title={L('Кусок с контекстом → ответ модели', 'Crop with context → model output')}>
      {piece} → {output.width}×{output.height}, {label}
    </p>
  );
}

/** Стиль документа: модель получает его с каждой задачей; ⌘↵ — сохранить, Esc — передумать */
function StyleDialog(props: { style: string; onClose: () => void; onSave: (style: string) => void }) {
  const [value, setValue] = useState(props.style);
  const field = useRef<HTMLTextAreaElement>(null);
  // autofocus браузер выполняет раз за загрузку страницы, а окно открывают много раз
  useEffect(() => {
    const el = field.current;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const save = () => props.onSave(value.trim());
  return (
    <div class="modal-backdrop" onClick={props.onClose}>
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="style-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="style-title">
          {L('Стиль документа', 'Document style')}
          <Help>{L('Добавляется к каждой задаче для модели и директора. Сохраняется в проекте .caaa, в картинку — нет.', 'Added to every task for the model and the director. Saved in the .caaa project, not in the image.')}</Help>
        </h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
          onKeyDown={(e) => {
            // Своё ⌘↵: общее сочетание отправило бы форму новой правки
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              e.stopPropagation();
              save();
            }
          }}
        >
          <textarea
            ref={field}
            rows={5}
            placeholder={L('Например: книжная иллюстрация, тёплый вечерний свет', 'For example: book illustration, warm evening light')}
            value={value}
            onInput={(e) => setValue(e.currentTarget.value)}
          />
          <div class="row">
            <button class="primary" type="submit" disabled={value.trim() === props.style.trim()} title="⌘↵">
              {L('Сохранить', 'Save')}
            </button>
            <button type="button" onClick={props.onClose}>
              {L('Отмена', 'Cancel')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function SettingsDialog(props: {
  gemini: StateDto['gemini'];
  codex: string | null;
  onClose: () => void;
  onSaved: (text: string) => void;
  onError: (err: unknown) => void;
}) {
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [language, setLanguage] = useState<{ choice: LangChoice; system: Lang } | null>(null);
  const mac = navigator.userAgent.includes('Mac');
  const { service } = props.gemini;
  const saved = props.gemini.keys[service];
  const name = GEMINI_SERVICE_NAMES[service];
  const chooseService = (next: GeminiService) => {
    setValue('');
    post('/api/settings/gemini', { service: next }).catch(props.onError);
  };
  useEffect(() => {
    fetch('/api/lang')
      .then((r) => r.json() as Promise<{ choice: LangChoice; system: Lang }>)
      .then(setLanguage, props.onError);
  }, []);
  // Подписи интерфейса считаются при загрузке, поэтому другой язык — перезагрузкой окна
  const chooseLang = (choice: LangChoice) =>
    post<{ lang: Lang; choice: LangChoice; system: Lang }>('/api/lang', { choice }).then((res) => {
      setLanguage(res);
      if (res.lang !== lang()) location.reload();
    }, props.onError);
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
        <h2 id="settings-title">{L('Настройки', 'Settings')}</h2>
        <h3>{L('Язык', 'Language')}</h3>
        {language && (
          <Seg
            label={L('Язык', 'Language')}
            value={language.choice}
            options={[
              { value: 'system', text: `${L('Как в системе', 'System')} · ${LANG_NAMES[language.system]}`, title: L('Язык системы', 'System language') },
              { value: 'en', text: LANG_NAMES.en, title: LANG_NAMES.en },
              { value: 'ru', text: LANG_NAMES.ru, title: LANG_NAMES.ru },
            ]}
            onChange={(choice) => void chooseLang(choice)}
          />
        )}
        <h3>
          Nano Banana
          <Help>
            {L(
              'Gemini API — у Google, ключ создаётся в Google AI Studio, генерации оплачиваются Google. Он работает не во всех странах (в России — нет); тогда — laozhang.ai, посредник с той же моделью и своей оплатой.',
              'Gemini API is Google’s own: create a key in Google AI Studio, generations are billed by Google. It is not available in every country; then use laozhang.ai, a proxy to the same model with its own billing.',
            )}
          </Help>
        </h3>
        <Seg
          label="Nano Banana"
          value={service}
          options={GEMINI_SERVICES.map((s) => ({ value: s, text: GEMINI_SERVICE_NAMES[s], title: props.gemini.keys[s] ? L('Ключ сохранён', 'Key saved') : L('Ключа нет', 'No key') }))}
          onChange={chooseService}
        />
        <p>
          {saved ? (
            L('Ключ сохранён.', 'Key saved.')
          ) : service === 'google' ? (
            <>
              {L('Ключ создаётся в ', 'Create a key in ')}
              <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
                Google AI Studio
              </a>
              .
            </>
          ) : (
            L('Ключ есть в личном кабинете laozhang.ai.', 'You can find the key in your laozhang.ai dashboard.')
          )}
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => post('/api/settings/key', { key: value, service }), L('Ключ сохранён', 'Key saved'));
          }}
        >
          <input
            type="password"
            autoFocus
            autoComplete="off"
            spellcheck={false}
            placeholder={saved ? L(`Новый ключ ${name}`, `New ${name} key`) : L(`Ключ ${name}`, `${name} key`)}
            value={value}
            onInput={(e) => setValue(e.currentTarget.value)}
          />
          <p class="hint">{mac ? L('Хранится в Связке ключей macOS', 'Stored in the macOS Keychain') : L('Хранится на этом компьютере зашифрованным', 'Stored encrypted on this computer')} {service === 'google' ? L('и уходит только в Google.', 'and is sent only to Google.') : L('и уходит только в laozhang.ai.', 'and is sent only to laozhang.ai.')}</p>
          <div class="row">
            <button class="primary" type="submit" disabled={!value.trim() || saving}>
              {L('Сохранить ключ', 'Save key')}
            </button>
            <button type="button" onClick={props.onClose}>
              {L('Закрыть', 'Close')}
            </button>
            {saved && (
              <button
                type="button"
                class="danger"
                disabled={saving}
                onClick={() => void run(() => post('/api/settings/key/clear', { service }), L('Ключ удалён', 'Key deleted'))}
              >
                {L('Удалить ключ', 'Delete key')}
              </button>
            )}
          </div>
        </form>
        <h3>{L('ChatGPT Images по подписке', 'ChatGPT Images on your subscription')}</h3>
        {props.codex ? (
          <>
            <p>{L('Картинки и директор идут через Codex по подписке ChatGPT, ключ не нужен.', 'Images and the director go through Codex on your ChatGPT subscription; no key needed.')}</p>
            <p class="hint">
              Codex: <code>{props.codex}</code>
              {mac
                ? L('. Если пишет, что вход не выполнен, войдите в Codex в приложении ChatGPT.', '. If it says you are not signed in, sign in to Codex in the ChatGPT app.')
                : L('. Если пишет, что вход не выполнен, войдите командой codex login.', '. If it says you are not signed in, sign in with codex login.')}
            </p>
          </>
        ) : (
          <p>
            {mac
              ? L('Не найден Codex. Установите приложение ChatGPT (Codex в нём есть) или Codex CLI и войдите в ChatGPT.', 'Codex not found. Install the ChatGPT app (it includes Codex) or Codex CLI and sign in to ChatGPT.')
              : L('Не найден Codex. Установите Codex CLI (npm install -g @openai/codex) и войдите в ChatGPT: codex login.', 'Codex not found. Install Codex CLI (npm install -g @openai/codex) and sign in to ChatGPT: codex login.')}
          </p>
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
  const preset = canvasPresets().find((p) => (p.width === width && p.height === height) || (p.width === height && p.height === width));
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
      <div class="presets" role="radiogroup" aria-label={L('Размер', 'Size')}>
        {canvasPresets().map((p) => {
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
          {L('Ширина', 'Width')}
          <input type="number" min={16} max={30000} value={width} onInput={(e) => setWidth(Number(e.currentTarget.value))} />
        </label>
        <button
          type="button"
          class="icon swap"
          title={L('Повернуть: поменять ширину и высоту', 'Rotate: swap width and height')}
          aria-label={L('Поменять ширину и высоту', 'Swap width and height')}
          onClick={() => {
            setWidth(height);
            setHeight(width);
          }}
        >
          <IconArrowsExchange size={16} stroke={STROKE} />
        </button>
        <label>
          {L('Высота', 'Height')}
          <input type="number" min={16} max={30000} value={height} onInput={(e) => setHeight(Number(e.currentTarget.value))} />
        </label>
        <label>
          {L('Фон', 'Background')}
          <input type="color" value={color} onInput={(e) => setColor(e.currentTarget.value)} />
        </label>
      </div>
      <p class="hint">{valid ? L(`${megapixels.toFixed(1).replace('.', ',')} Мп${preset?.dpi ? `, для печати ${preset.dpi} dpi` : ''}`, `${megapixels.toFixed(1)} MP${preset?.dpi ? `, ${preset.dpi} dpi for print` : ''}`) : L('Каждая сторона — от 16 до 30 000 пикселей', 'Each side — 16 to 30,000 pixels')}</p>
      <div class="row">
        <button type="submit" class="primary" disabled={!valid || creating}>
          {L('Создать холст', 'Create canvas')}
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
              <h1>{L('Откройте картинку', 'Open an image')}</h1>
              <p class="hint">{L('PNG, JPEG, WebP, TIFF или проект .caaa', 'PNG, JPEG, WebP, TIFF or a .caaa project')}</p>
            </div>
            <button class="primary" onClick={props.onOpen}>
              {L('Открыть…', 'Open…')}
            </button>
          </header>
          <h2>{L('Недавние', 'Recent')}</h2>
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
            <p class="hint">{L('Пока пусто', 'Nothing yet')}</p>
          )}
        </section>
        <section class="start-new">
          <h1>{L('Или новый холст', 'Or a new canvas')}</h1>
          <NewCanvasForm onError={props.onError} />
        </section>
      </div>
    </div>
  );
}
