import {
  IconArrowBackUp,
  IconArrowForwardUp,
  IconArrowsExchange,
  IconBlur,
  IconBrush,
  IconChevronLeft,
  IconChevronRight,
  IconEraser,
  IconEye,
  IconEyeOff,
  IconHandStop,
  IconHelpCircle,
  IconLasso,
  IconMarquee2,
  IconMask,
  IconMinus,
  IconPencil,
  IconPhotoPlus,
  IconPlus,
  IconRefresh,
  IconScribble,
  IconTrash,
  IconX,
  type Icon,
} from '@tabler/icons-preact';
import type { ComponentChildren } from 'preact';
import { createPortal } from 'preact/compat';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { adviseSize, intersect, type ModelOutputs, type SizeAdvice } from '../core/frame.ts';
import {
  CANVAS_PRESETS,
  COMMAND_EVENT,
  MAX_REFERENCES,
  shapesBBox,
  type AppCommand,
  type DocDto,
  type JobDto,
  type MaskEditResult,
  type MaskShape,
  type ModelChoice,
  type ModelOutputsDto,
  type PatchDto,
  type RecentDto,
  type RedoChange,
  type SizeChoice,
  type SketchStroke,
  type StateDto,
} from '../shared/api.ts';
import { getState, post, subscribe, upload, uploadReference } from './api.ts';
import { CanvasView, type MaskEditView, type Tool } from './viewer.ts';

function plural(n: number, one: string, few: string, many: string): string {
  const d = n % 10;
  const dd = n % 100;
  if (d === 1 && dd !== 11) return one;
  if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return few;
  return many;
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

/** То же для задачи: под ней весь холст, слой — выбранный вариант */
function jobMaskEdit(job: JobDto, doc: DocDto): MaskEditView | null {
  if (!job.inside) return null;
  const base = `/api/jobs/${job.id}/edit`;
  return {
    kind: 'job',
    target: job.id,
    rect: job.inside,
    feather: job.feather ?? 0,
    below: `${base}/below.jpg?rev=${doc.rev}`,
    above: `${base}/above.png?rev=${doc.rev}`,
    layer: `${base}/layer.jpg?n=${job.selected}`,
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
  hand: IconHandStop,
  rect: IconMarquee2,
  lasso: IconLasso,
  brush: IconBrush,
  eraser: IconEraser,
  sketch: IconScribble,
};

const TOOLS: { id: Tool; label: string; key: string }[] = [
  { id: 'rect', label: 'Прямоугольник', key: 'R' },
  { id: 'lasso', label: 'Лассо', key: 'L' },
  { id: 'brush', label: 'Кисть', key: 'B' },
  { id: 'eraser', label: 'Ластик', key: 'E' },
  { id: 'sketch', label: 'Набросок для модели, Alt стирает', key: 'S' },
  { id: 'hand', label: 'Рука (или зажать пробел)', key: 'H' },
];

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
  return job.directing ? 'Директор думает' : STATUS[job.status];
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
  const [brush, setBrush] = useState(40);
  /** Мягкость края кисти при правке маски, 0..1 */
  const [softness, setSoftness] = useState(0.5);
  const [selection, setSelection] = useState<MaskShape[]>([]);
  /** Набросок для модели к новой правке */
  const [sketch, setSketch] = useState<SketchStroke[]>([]);
  const [sketchSize, setSketchSize] = useState(10);
  const [sketchColor, setSketchColor] = useState(SKETCH_COLORS[0]!);
  const [prompt, setPrompt] = useState('');
  /** Стереть модели то, что под выделением */
  const [hide, setHide] = useState(false);
  /** Перед генерацией ChatGPT расписывает задачу */
  const [director, setDirector] = useState(false);
  const [model, setModel] = useState<ModelChoice>('flash');
  const [size, setSize] = useState<SizeChoice>('auto');
  const [variants, setVariants] = useState(2);
  const [focusJob, setFocusJob] = useState<string | null>(null);
  const [maskJob, setMaskJob] = useState<string | null>(null);
  /** Слой, маску которого сейчас правят */
  const [maskLayer, setMaskLayer] = useState<string | null>(null);
  const [zoom, setZoom] = useState(0);
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [styleDraft, setStyleDraft] = useState('');
  const [dialog, setDialog] = useState<'settings' | 'new' | null>(null);
  const [zoomMenu, setZoomMenu] = useState(false);
  const [refs, setRefs] = useState<string[]>([]);
  const [, setTick] = useState(0);

  const stageRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const refRef = useRef<HTMLInputElement>(null);
  const viewRef = useRef<CanvasView | null>(null);
  const numbers = useRef(new Map<string, number>());
  const nextNumber = useRef(1);
  const refreshSeq = useRef(0);
  const onShape = useRef<(shape: MaskShape) => void>(() => undefined);
  const onSketch = useRef<(stroke: SketchStroke) => void>(() => undefined);
  /** В каком порядке в форму новой правки ложились фигуры выделения и штрихи наброска — ⌘Z убирает последнее */
  const formOrder = useRef<('shape' | 'sketch')[]>([]);
  const onMaskShape = useRef<(view: MaskEditView, shape: MaskShape) => Promise<MaskEditResult>>(() => Promise.reject(new Error('Нет правки маски')));
  const styleTimer = useRef<number | undefined>(undefined);
  const toastTimer = useRef<number | undefined>(undefined);

  const doc = state?.doc ?? null;
  const jobs = state?.jobs ?? [];
  const layers = state?.history ?? [];
  const editedLayer = layers.find((p) => p.id === maskLayer && p.active) ?? null;
  const editedJob = jobs.find((j) => j.id === maskJob && j.status === 'done') ?? null;
  const maskEdit = editedLayer ? layerMaskEdit(editedLayer, layers) : editedJob && doc ? jobMaskEdit(editedJob, doc) : null;

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
      onShape: (shape) => onShape.current(shape),
      onSketch: (stroke) => onSketch.current(stroke),
      onMaskShape: (view, shape) => onMaskShape.current(view, shape),
      onZoom: setZoom,
    });
    refresh();
    return subscribe(refresh);
  }, []);

  // Номера задач — по порядку создания, чтобы карточка и область на холсте совпадали
  for (const job of [...jobs].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (!numbers.current.has(job.id)) numbers.current.set(job.id, nextNumber.current++);
  }

  useEffect(() => viewRef.current?.setDocument(doc), [doc?.id, doc?.rev]);
  useEffect(() => {
    document.title = doc ? `${doc.name}${doc.dirty ? ' •' : ''} — canvaaaas` : 'canvaaaas';
  }, [doc?.name, doc?.dirty]);
  useEffect(() => {
    setStyleDraft(doc?.style ?? '');
    setSelection([]);
    setSketch([]);
    formOrder.current = [];
    setMaskJob(null);
    setMaskLayer(null);
  }, [doc?.id]);
  useEffect(() => {
    if (maskJob && !editedJob) setMaskJob(null);
    viewRef.current?.setJobs(jobs, numbers.current, focusJob);
  }, [state?.jobs, focusJob, maskJob]);
  // Скрытый или отменённый слой маску больше не правит
  useEffect(() => {
    if (maskLayer && !editedLayer) setMaskLayer(null);
  }, [maskLayer, editedLayer?.id]);
  const maskEditKey = JSON.stringify(maskEdit);
  useEffect(() => viewRef.current?.setMaskEdit(maskEdit), [maskEditKey]);
  useEffect(() => viewRef.current?.setSelection(selection), [selection]);
  useEffect(() => viewRef.current?.setSketch(sketch), [sketch]);
  useEffect(() => viewRef.current?.setSketchBrush(sketchSize, sketchColor), [sketchSize, sketchColor]);
  useEffect(() => viewRef.current?.setTool(tool), [tool]);
  useEffect(() => viewRef.current?.setBrush(brush, softness), [brush, softness]);

  const anyRunning = jobs.some((j) => j.status !== 'done' && j.status !== 'error');
  useEffect(() => {
    if (!anyRunning) return;
    const t = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [anyRunning]);

  onShape.current = (shape) => {
    formOrder.current.push('shape');
    setSelection((s) => [...s, shape]);
  };
  onSketch.current = (stroke) => {
    formOrder.current.push('sketch');
    setSketch((s) => [...s, stroke]);
  };
  const clearSelection = () => {
    formOrder.current = formOrder.current.filter((k) => k !== 'shape');
    setSelection([]);
  };
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
  const canGenerate = !!doc && hasSelection && prompt.trim().length > 0 && !maskJob && !maskLayer;
  // Директор идёт через Codex; у подставной модели — подставной директор
  const canDirect = state?.provider === 'mock' || !!state?.codex;
  // У ChatGPT одно разрешение — его выбирает сама модель
  const sizeFor = (m: ModelChoice): SizeChoice => (m === 'chatgpt' ? 'auto' : size);
  const sizeAdvice = doc && state && hasSelection ? adviseSelection(doc, selection, state.models[model], sizeFor(model)) : null;

  const generate = async () => {
    if (!canGenerate) return;
    if (needsKey(model) && !state?.hasKey) {
      setDialog('settings');
      return;
    }
    try {
      const { id } = await post<{ id: string }>('/api/jobs', {
        shapes: selection,
        prompt,
        variants,
        model,
        size: sizeFor(model),
        refs,
        hide,
        sketch: hasSketch ? sketch : undefined,
        director: director && canDirect,
      });
      // Форма — для следующей области: задача, набросок, референсы и скрытие у неё свои; модель, разрешение, число вариантов и директор остаются
      setSelection([]);
      setSketch([]);
      formOrder.current = [];
      setPrompt('');
      setRefs([]);
      setHide(false);
      setFocusJob(id);
    } catch (err) {
      fail(err);
    }
  };

  // Правки маски слоя — обычные шаги истории документа, поэтому в режиме маски слоя ⌘Z отменяет их
  const undo = () => {
    if (maskJob) post(`/api/jobs/${maskJob}/mask/undo`).then(maskChanged, fail);
    else if ((selection.length || sketch.length) && !maskLayer) undoForm();
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

  const switchVariant = (job: JobDto, dir: number) => {
    const done = job.variants.filter((v) => v.status === 'done').map((v) => v.n);
    const i = done.indexOf(job.selected);
    const n = done[(i + dir + done.length) % done.length];
    if (n !== undefined && n !== job.selected) post(`/api/jobs/${job.id}/select`, { n }).catch(fail);
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
    if (!down) return;
    if (mod && e.key === 'Enter') {
      e.preventDefault();
      void generate();
      return;
    }
    if (e.key === 'Escape') {
      if (zoomMenu) setZoomMenu(false);
      else if (dialog) setDialog(null);
      else if (maskJob) setMaskJob(null);
      else if (maskLayer) setMaskLayer(null);
      else clearSelection();
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
        '0': 'zoom-fit',
        '1': 'zoom-100',
        '2': 'zoom-50',
        '=': 'zoom-in',
        '+': 'zoom-in',
        '-': 'zoom-out',
      };
      const command = e.shiftKey && key === 's' ? 'save-as' : e.shiftKey && key === 'e' ? 'export' : e.shiftKey || e.altKey ? undefined : byKey[key];
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
    const t = TOOLS.find((x) => x.key.toLowerCase() === e.key.toLowerCase());
    if (t) setTool(t.id);
    // [ и ] — размер кисти, с Shift — жёсткость, как в Photoshop: ⇧[ мягче, ⇧] жёстче. По коду клавиши — в русской раскладке тоже
    if (e.code === 'BracketLeft' || e.code === 'BracketRight') {
      const up = e.code === 'BracketRight';
      if (e.shiftKey) setSoftness((v) => Math.min(1, Math.max(0, Math.round((v + (up ? -0.25 : 0.25)) * 4) / 4)));
      else if (tool === 'sketch') setSketchSize((b) => (up ? Math.min(120, Math.round(b * 1.25) + 1) : Math.max(2, Math.round(b / 1.25))));
      else setBrush((b) => (up ? Math.min(400, Math.round(b * 1.25)) : Math.max(4, Math.round(b / 1.25))));
    }
    const focused = jobs.find((j) => j.id === focusJob);
    if (focused && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) switchVariant(focused, e.key === 'ArrowLeft' ? -1 : 1);
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

  // Маску слоя правят прежде всего, чтобы скрыть кусок, поэтому сразу ластик
  const editLayerMask = (patch: PatchDto) => {
    if (maskLayer === patch.id) {
      setMaskLayer(null);
      return;
    }
    setMaskLayer(patch.id);
    setMaskJob(null);
    setTool('eraser');
    viewRef.current?.reveal(patch.rect);
  };

  const focus = (job: JobDto) => {
    setFocusJob(job.id);
    const r = job.inside ?? job.bbox;
    if (r) viewRef.current?.showRect(r);
  };

  /** Ещё варианты задачи в очереди, можно с поправкой; с ошибкой до подготовки куска — начать её заново */
  const redoJob = (job: JobDto, change: RedoChange = {}) =>
    job.inside ? post(`/api/jobs/${job.id}/more`, { count: variants, ...change }) : post(`/api/jobs/${job.id}/retry`, change);

  // Ещё варианты принятого слоя, можно с поправкой: если они уже в очереди — туда же, а не второй задачей на тот же слой
  const layerVariants = async (patch: PatchDto, change: RedoChange = {}) => {
    if (needsKey(patch.model ?? model) && !state?.hasKey) {
      setDialog('settings');
      return;
    }
    const open = jobs.find((j) => j.replaces === patch.id);
    try {
      if (open) {
        focus(open);
        const idle = (open.status === 'done' || open.status === 'error') && !open.variants.some((v) => v.status === 'running');
        if (idle) await redoJob(open, change);
        else notify('Варианты этого слоя уже генерируются', false);
        return;
      }
      const { id } = await post<{ id: string }>(`/api/history/${patch.id}/variants`, { variants, model, size: sizeFor(model), ...change });
      setFocusJob(id);
      viewRef.current?.showRect(patch.rect);
    } catch (err) {
      fail(err);
    }
  };

  const deleteLayer = (patch: PatchDto) => {
    post(`/api/history/${patch.id}/delete`)
      .then(() => notify(`Слой «${short(patch.prompt)}» удалён. ⌘Z вернёт его`, false))
      .catch(fail);
  };

  const sortedJobs = [...jobs].sort((a, b) => (numbers.current.get(b.id) ?? 0) - (numbers.current.get(a.id) ?? 0));

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
                disabled={!state?.canUndo && !selection.length && !sketch.length && !maskJob}
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

      <nav class="rail" aria-label="Инструменты">
        {TOOLS.map((t) => {
          const ToolIcon = TOOL_ICONS[t.id];
          // Набросок — подсказка модели к новой правке, а не выделение: отдельно от инструментов выделения
          const button = (
            <button
              key={t.id}
              class={tool === t.id ? 'tool active' : 'tool'}
              title={t.id === 'sketch' && (maskJob || maskLayer) ? 'Набросок — только для новой правки' : `${t.label} (${t.key})`}
              aria-label={t.label}
              aria-pressed={tool === t.id}
              disabled={t.id === 'sketch' && !!(maskJob || maskLayer)}
              onClick={() => setTool(t.id)}
            >
              <ToolIcon size={22} stroke={STROKE} />
            </button>
          );
          return t.id === 'sketch' ? [<span class="rail-sep" key="sep" />, button] : button;
        })}
        {tool === 'sketch' && (
          <>
            <label class="brush-size" title="Толщина наброска на экране ([ и ])">
              <input
                type="range"
                min={2}
                max={120}
                value={sketchSize}
                aria-label="Толщина наброска"
                onInput={(e) => setSketchSize(Number(e.currentTarget.value))}
              />
              <span>{sketchSize}</span>
            </label>
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
        {(tool === 'brush' || tool === 'eraser') && (
          <label class="brush-size" title="Размер кисти на экране ([ и ])">
            <input type="range" min={4} max={400} value={brush} aria-label="Размер кисти" onInput={(e) => setBrush(Number(e.currentTarget.value))} />
            <span>{brush}</span>
          </label>
        )}
        {(tool === 'brush' || tool === 'eraser') && (maskJob || maskLayer) && (
          <label class="brush-size" title="Мягкость края кисти: 0% — жёсткий край, 100% — затухает от середины (⇧[ и ⇧])">
            <IconBlur size={16} stroke={STROKE} aria-hidden="true" />
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={Math.round(softness * 100)}
              aria-label="Мягкость края кисти"
              onInput={(e) => setSoftness(Number(e.currentTarget.value) / 100)}
            />
            <span>{Math.round(softness * 100)}%</span>
          </label>
        )}
      </nav>

      <main class={maskJob || maskLayer ? 'stage mask-mode' : 'stage'}>
        <div ref={stageRef} class="osd" />
        {maskJob && (
          <div class="stage-banner">
            Маска задачи #{numbers.current.get(maskJob)}
            <Help>Кисть и фигуры добавляют к маске, ластик и Alt стирают. Мягкость кисти — ⇧[ и ⇧].</Help>
            <button onClick={() => setMaskJob(null)}>Готово</button>
          </div>
        )}
        {editedLayer && (
          <div class="stage-banner">
            Маска слоя «{short(editedLayer.prompt)}»
            <Help>Ластик и Alt скрывают часть слоя, кисть и фигуры возвращают её — и за краем прежнего выделения. ⌘Z отменяет мазок.</Help>
            <button onClick={() => setMaskLayer(null)}>Готово</button>
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
                  Выделите область прямоугольником (R), лассо (L) или кистью (B), с Alt — вычесть из выделения. Набросок (S) — подсказка
                  модели: где и каким должно быть то, что в задаче; с Alt он стирается. ⌘Z убирает последнее, ⌘D снимает выделение, ⌘↵ —
                  сгенерировать.
                </Help>
              </h2>
              {(selection.length > 0 || sketch.length > 0) && (
                <div class="chips">
                  {selection.length > 0 && (
                    <Chip icon={IconMarquee2} label="Выделение" clear="Снять выделение (⌘D)" onClear={clearSelection} />
                  )}
                  {sketch.length > 0 && <Chip icon={IconScribble} label="Набросок" clear="Стереть набросок" onClear={clearSketch} />}
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
                  Варианты
                  <select value={variants} onChange={(e) => setVariants(Number(e.currentTarget.value))}>
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
              <button class="primary" disabled={!canGenerate} onClick={generate} title="⌘↵">
                Сгенерировать {variants} {plural(variants, 'вариант', 'варианта', 'вариантов')}
              </button>
            </section>

            {jobs.length > 0 && (
              <section class="panel">
                <h2>
                  Очередь <span class="dim">{jobs.length}</span>
                </h2>
                {sortedJobs.map((job) => (
                  <JobCard
                    key={job.id}
                    job={job}
                    canDirect={canDirect}
                    replacing={job.replaces === undefined ? undefined : (layers.find((p) => p.id === job.replaces) ?? null)}
                    number={numbers.current.get(job.id) ?? 0}
                    focused={job.id === focusJob}
                    maskMode={job.id === maskJob}
                    variants={variants}
                    onFocus={() => focus(job)}
                    onSwitch={(dir) => switchVariant(job, dir)}
                    onMaskMode={() => {
                      setMaskJob(maskJob === job.id ? null : job.id);
                      setMaskLayer(null);
                      setFocusJob(job.id);
                      if (tool === 'hand' || tool === 'sketch') setTool('brush');
                    }}
                    onRedo={(change) => {
                      if (needsKey(job.model) && !state?.hasKey) setDialog('settings');
                      else redoJob(job, change).catch(fail);
                    }}
                    onAction={(action) => {
                      if (action === 'expand') {
                        post<{ addedPx: number }>(`/api/jobs/${job.id}/mask/expand`)
                          .then(({ addedPx }) => {
                            if (addedPx) maskChanged();
                            const area = job.inside ? job.inside.width * job.inside.height : 1;
                            notify(
                              addedPx
                                ? `Маска выросла на ${((100 * addedPx) / area).toFixed(1)}% куска`
                                : 'За краем выделения модель ничего не дорисовала',
                              false,
                            );
                          })
                          .catch(fail);
                        return;
                      }
                      const path = { accept: 'accept', discard: 'discard', retry: 'retry', more: 'more', undoMask: 'mask/undo' }[action];
                      if (action === 'accept' || action === 'discard') setMaskJob(null);
                      post(`/api/jobs/${job.id}/${path}`, action === 'more' ? { count: variants } : undefined)
                        .then(() => action === 'undoMask' && maskChanged())
                        .catch(fail);
                    }}
                  />
                ))}
              </section>
            )}

            {layers.length > 0 && (
              <section class="panel">
                <h2>Слои</h2>
                <ol class="layers">
                  {[...layers].reverse().map((p) => (
                    <LayerItem
                      key={p.id}
                      patch={p}
                      canDirect={canDirect}
                      maskMode={p.id === maskLayer}
                      variants={variants}
                      onToggle={() => post(`/api/history/${p.id}/toggle`).catch(fail)}
                      onShow={() => viewRef.current?.showRect(p.rect)}
                      onMask={() => editLayerMask(p)}
                      onVariants={(change) => void layerVariants(p, change)}
                      onDelete={() => deleteLayer(p)}
                    />
                  ))}
                </ol>
              </section>
            )}
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

type JobAction = 'accept' | 'discard' | 'retry' | 'more' | 'expand' | 'undoMask';

function JobCard(props: {
  job: JobDto;
  /** Директор доступен: есть Codex */
  canDirect: boolean;
  /** Слой, который заменит принятый вариант; null — его уже удалили */
  replacing?: PatchDto | null;
  number: number;
  focused: boolean;
  maskMode: boolean;
  /** Сколько вариантов сгенерировать */
  variants: number;
  onFocus: () => void;
  onSwitch: (dir: number) => void;
  onMaskMode: () => void;
  onAction: (action: JobAction) => void;
  onRedo: (change: RedoChange) => void;
}) {
  const { job } = props;
  const [redoing, setRedoing] = useState(false);
  const done = job.variants.filter((v) => v.status === 'done');
  const running = job.variants.filter((v) => v.status === 'running').length;
  const selected = job.variants[job.selected];
  const index = done.findIndex((v) => v.n === job.selected);
  const busy = job.status === 'queued' || job.status === 'preparing' || job.status === 'running';
  const replacing = props.replacing;
  // Вариант сделан не с той задачей, что сейчас в карточке: после повтора с поправкой
  const otherTask = selected && (selected.prompt !== job.prompt || selected.hide !== job.hide) ? selected : null;
  // Текст директора — того варианта, что на холсте; пока вариантов нет — для следующих
  const directed = (selected?.status === 'done' ? selected.directed : undefined) ?? job.directed;
  // Поправить задачу можно, когда новых вариантов не ждём
  const canRedo = (job.status === 'done' && running === 0) || job.status === 'error';
  useEffect(() => {
    if (!canRedo) setRedoing(false);
  }, [canRedo]);
  const redoForm = redoing && canRedo && (
    <RedoForm
      prompt={job.prompt}
      hide={job.hide}
      director={job.director}
      canDirect={props.canDirect}
      variants={props.variants}
      onCancel={() => setRedoing(false)}
      onSubmit={(change) => {
        setRedoing(false);
        props.onRedo(change);
      }}
    />
  );

  return (
    <article class={`job ${job.status}${props.focused ? ' focused' : ''}`} onClick={props.onFocus}>
      <header>
        <span class="job-number">#{props.number}</span>
        <p class="job-prompt">{job.prompt}</p>
        {canRedo && (
          <button
            class={redoing ? 'icon redo-toggle active' : 'icon redo-toggle'}
            title={`Поправить задачу и сгенерировать ещё ${props.variants} ${plural(props.variants, 'вариант', 'варианта', 'вариантов')}`}
            aria-label="Поправить задачу"
            aria-pressed={redoing}
            onClick={(e) => {
              e.stopPropagation();
              setRedoing((v) => !v);
            }}
          >
            <IconPencil size={16} stroke={STROKE} />
          </button>
        )}
      </header>
      {directed && !redoing && <Directed text={directed} />}
      {redoForm}
      <p class="job-status">
        {jobStatus(job)}
        {job.status === 'running' && `, готово ${done.length} из ${job.variants.length}`}
        {busy && `, ${clock(Date.now() - Date.parse(job.createdAt))}`}
        {job.status === 'done' && running > 0 && `, ещё ${running} в работе`}
        {job.modelSize && <span class="dim">, {[job.imageSize, MODELS.find((m) => m.id === job.model)?.tag].filter(Boolean).join(' ')}</span>}
        {job.refs > 0 && <span class="dim">, референсов: {job.refs}</span>}
        {job.sketch && <span class="dim">, с наброском</span>}
        {job.hide && <span class="dim">, под маской стёрто</span>}
      </p>
      {replacing !== undefined && (
        <p class="hint">
          {replacing ? (
            <>
              Замена слоя
              <Help>Модель видит холст под слоем. Принятый вариант ляжет на место слоя, «Отклонить» оставит слой как был.</Help>
            </>
          ) : (
            'Слой удалён: вариант ляжет новым слоем'
          )}
        </p>
      )}
      {job.error && <p class="job-error">{job.error}</p>}
      {job.warnings.map((w) => (
        <p class="job-warning">{w}</p>
      ))}

      {job.status === 'done' && (
        <div class="job-body" onClick={(e) => e.stopPropagation()}>
          <div class="variants">
            <button class="icon" aria-label="Предыдущий вариант" disabled={done.length < 2} onClick={() => props.onSwitch(-1)}>
              <IconChevronLeft size={16} stroke={STROKE} />
            </button>
            <span>
              {selected?.current ? 'Нынешний слой, ' : 'Вариант '}
              {index + 1} из {done.length}
              {selected?.elapsedMs !== undefined && <span class="dim">, {Math.round(selected.elapsedMs / 1000)} с</span>}
            </span>
            <button class="icon" aria-label="Следующий вариант" disabled={done.length < 2} onClick={() => props.onSwitch(1)}>
              <IconChevronRight size={16} stroke={STROKE} />
            </button>
          </div>
          {otherTask && (
            <p class="hint variant-task">
              {otherTask.prompt === job.prompt ? 'С той же задачей' : `По прежней задаче: «${otherTask.prompt}»`}
              {otherTask.hide !== job.hide && (otherTask.hide ? ', под маской было стёрто' : ', модель видела, что под маской')}
            </p>
          )}
          {selected?.insideChangedPct !== undefined && selected.insideChangedPct < 2 && (
            <p class="job-warning">
              Модель почти ничего не изменила
              <Help>Опишите, что должно получиться, а не что исправить, или выделите область поменьше.</Help>
            </p>
          )}
          <div class="row">
            <button class="primary" onClick={() => props.onAction('accept')}>
              {!replacing ? 'Принять' : selected?.current ? 'Оставить этот' : 'Заменить слой'}
            </button>
            <button onClick={() => props.onAction('discard')}>Отклонить</button>
            <button onClick={() => props.onAction('more')} disabled={running > 0}>
              Ещё варианты
            </button>
          </div>
          <div class="row mask-row">
            <button class={props.maskMode ? 'active' : ''} aria-pressed={props.maskMode} onClick={props.onMaskMode}>
              {props.maskMode ? 'Закончить с маской' : 'Править маску'}
            </button>
            <button title="Добавить к маске то, что модель нарисовала за краем выделения" onClick={() => props.onAction('expand')}>
              Расширить по правке
            </button>
            <button
              class="icon"
              title="Отменить правку маски"
              aria-label="Отменить правку маски"
              disabled={!job.canUndoMask}
              onClick={() => props.onAction('undoMask')}
            >
              <IconArrowBackUp size={16} stroke={STROKE} />
            </button>
          </div>
        </div>
      )}

      {(busy || job.status === 'error') && (
        <div class="row" onClick={(e) => e.stopPropagation()}>
          {job.status === 'error' && (
            <button class="primary" onClick={() => props.onAction(job.inside ? 'more' : 'retry')}>
              Повторить
            </button>
          )}
          <button onClick={() => props.onAction('discard')}>{busy ? 'Отменить' : 'Убрать'}</button>
        </div>
      )}
    </article>
  );
}

function LayerItem(props: {
  patch: PatchDto;
  canDirect: boolean;
  maskMode: boolean;
  /** Сколько вариантов сгенерировать */
  variants: number;
  onToggle: () => void;
  onShow: () => void;
  onMask: () => void;
  /** Ещё варианты; change — с поправленной задачей */
  onVariants: (change?: RedoChange) => void;
  onDelete: () => void;
}) {
  const { patch } = props;
  const [redoing, setRedoing] = useState(false);
  const time = new Date(patch.createdAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return (
    <li class={[patch.active ? '' : 'off', props.maskMode ? 'editing' : ''].filter(Boolean).join(' ')}>
      <button
        class="layer-icon"
        title={patch.active ? 'Скрыть слой' : 'Показать слой'}
        aria-label="Показывать слой"
        aria-pressed={patch.active}
        onClick={props.onToggle}
      >
        {patch.active ? <IconEye size={18} stroke={STROKE} /> : <IconEyeOff size={18} stroke={STROKE} />}
      </button>
      <button class="link" onClick={props.onShow} title={patch.directed ? `Показать на холсте\n\nДиректор: ${patch.directed}` : 'Показать на холсте'}>
        {patch.prompt}
      </button>
      <span class="dim">{time}</span>
      <button
        class={props.maskMode ? 'layer-icon active' : 'layer-icon'}
        title={!patch.active ? 'Слой скрыт: сначала покажите его' : props.maskMode ? 'Закончить с маской (Esc)' : 'Править маску: скрыть часть слоя или вернуть'}
        aria-label="Править маску слоя"
        aria-pressed={props.maskMode}
        disabled={!patch.active}
        onClick={props.onMask}
      >
        <IconMask size={18} stroke={STROKE} />
      </button>
      <button
        class="layer-icon"
        title={`Ещё ${props.variants} ${plural(props.variants, 'вариант', 'варианта', 'вариантов')} этой правки: та же задача и маска; выбранный заменит слой`}
        aria-label="Ещё варианты слоя"
        onClick={() => props.onVariants()}
      >
        <IconRefresh size={18} stroke={STROKE} />
      </button>
      <button
        class={redoing ? 'layer-icon active' : 'layer-icon'}
        title={`Ещё ${props.variants} ${plural(props.variants, 'вариант', 'варианта', 'вариантов')} с поправленной задачей; выбранный заменит слой`}
        aria-label="Перерисовать слой с поправкой"
        aria-pressed={redoing}
        onClick={() => setRedoing((v) => !v)}
      >
        <IconPencil size={18} stroke={STROKE} />
      </button>
      <button class="layer-icon delete" title="Удалить слой (⌘Z вернёт его)" aria-label="Удалить слой" onClick={props.onDelete}>
        <IconTrash size={18} stroke={STROKE} />
      </button>
      {redoing && (
        <div class="layer-redo">
          <RedoForm
            prompt={patch.prompt}
            hide={patch.hide ?? false}
            director={patch.directed !== undefined}
            canDirect={props.canDirect}
            variants={props.variants}
            onCancel={() => setRedoing(false)}
            onSubmit={(change) => {
              setRedoing(false);
              props.onVariants(change);
            }}
          />
        </div>
      )}
    </li>
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
        получает оба текста; ваша задача остаётся как есть, текст директора — в карточке под ней. Идёт по подписке ChatGPT через Codex,
        добавляет около минуты.
      </Help>
    </span>
  );
}

/** Задача, как её расписал директор: две строки, по щелчку — целиком */
function Directed(props: { text: string }) {
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
      <span class="directed-label">Директор</span> {props.text}
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
          Сгенерировать {props.variants} {plural(props.variants, 'вариант', 'варианта', 'вариантов')}
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
