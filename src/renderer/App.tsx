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
  IconLasso,
  IconMarquee2,
  IconMask,
  IconMinus,
  IconPhotoPlus,
  IconPlus,
  IconX,
  type Icon,
} from '@tabler/icons-preact';
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  CANVAS_PRESETS,
  COMMAND_EVENT,
  MAX_REFERENCES,
  type AppCommand,
  type JobDto,
  type MaskShape,
  type ModelChoice,
  type PatchDto,
  type RecentDto,
  type SizeChoice,
  type StateDto,
} from '../shared/api.ts';
import { getState, post, subscribe, upload, uploadReference } from './api.ts';
import { CanvasView, type Tool } from './viewer.ts';

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

// Иконки — Tabler (tabler.io/icons), обводка чуть тоньше стандартной
const STROKE = 1.75;

const TOOL_ICONS: Record<Tool, Icon> = {
  hand: IconHandStop,
  rect: IconMarquee2,
  lasso: IconLasso,
  brush: IconBrush,
  eraser: IconEraser,
};

const TOOLS: { id: Tool; label: string; key: string }[] = [
  { id: 'rect', label: 'Прямоугольник', key: 'R' },
  { id: 'lasso', label: 'Лассо', key: 'L' },
  { id: 'brush', label: 'Кисть', key: 'B' },
  { id: 'eraser', label: 'Ластик', key: 'E' },
  { id: 'hand', label: 'Рука (или зажать пробел)', key: 'H' },
];

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
  const [prompt, setPrompt] = useState('');
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
  const styleTimer = useRef<number | undefined>(undefined);
  const toastTimer = useRef<number | undefined>(undefined);

  const doc = state?.doc ?? null;
  const jobs = state?.jobs ?? [];
  const layers = state?.history ?? [];
  const editedLayer = layers.find((p) => p.id === maskLayer && p.active) ?? null;

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
    setMaskJob(null);
    setMaskLayer(null);
  }, [doc?.id]);
  useEffect(() => {
    if (maskJob && !jobs.some((j) => j.id === maskJob && j.status === 'done')) setMaskJob(null);
    viewRef.current?.setJobs(jobs, numbers.current, focusJob, maskJob);
  }, [state?.jobs, focusJob, maskJob]);
  // Скрытый или отменённый слой маску больше не правит
  useEffect(() => {
    if (maskLayer && !editedLayer) setMaskLayer(null);
    viewRef.current?.setLayerMask(
      editedLayer && {
        id: editedLayer.id,
        key: `${editedLayer.id}:${editedLayer.maskRev}`,
        url: `/api/history/${editedLayer.id}/mask.png?v=${editedLayer.maskRev}`,
        rect: editedLayer.rect,
      },
    );
  }, [maskLayer, editedLayer?.id, editedLayer?.maskRev]);
  useEffect(() => viewRef.current?.setSelection(selection), [selection]);
  useEffect(() => viewRef.current?.setTool(tool), [tool]);
  useEffect(() => viewRef.current?.setBrush(brush, softness), [brush, softness]);

  const anyRunning = jobs.some((j) => j.status !== 'done' && j.status !== 'error');
  useEffect(() => {
    if (!anyRunning) return;
    const t = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [anyRunning]);

  const maskFail = (err: unknown) => {
    viewRef.current?.clearPending();
    fail(err);
  };
  onShape.current = (shape) => {
    if (maskJob) post(`/api/jobs/${maskJob}/mask`, { shapes: [shape] }).catch(maskFail);
    else if (maskLayer) post(`/api/history/${maskLayer}/mask`, { shapes: [shape] }).catch(maskFail);
    else setSelection((s) => [...s, shape]);
  };

  const hasSelection = selection.some((s) => !s.erase);
  const canGenerate = !!doc && hasSelection && prompt.trim().length > 0 && !maskJob && !maskLayer;

  const generate = async () => {
    if (!canGenerate) return;
    if (!state?.hasKey) {
      setDialog('settings');
      return;
    }
    try {
      const { id } = await post<{ id: string }>('/api/jobs', { shapes: selection, prompt, variants, model, size, refs });
      setSelection([]);
      setFocusJob(id);
    } catch (err) {
      fail(err);
    }
  };

  // Правки маски слоя — обычные шаги истории документа, поэтому в режиме маски слоя ⌘Z отменяет их
  const undo = () => {
    if (maskJob) post(`/api/jobs/${maskJob}/mask/undo`).catch(fail);
    else if (selection.length && !maskLayer) setSelection((s) => s.slice(0, -1));
    else if (state?.canUndo) post('/api/history/undo').catch(fail);
  };
  const redo = () => {
    if (state?.canRedo) post('/api/history/redo').catch(fail);
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
      else setSelection([]);
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
                disabled={!state?.canUndo && !selection.length && !maskJob}
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
          return (
            <button
              key={t.id}
              class={tool === t.id ? 'tool active' : 'tool'}
              title={`${t.label} (${t.key})`}
              aria-label={t.label}
              aria-pressed={tool === t.id}
              onClick={() => setTool(t.id)}
            >
              <ToolIcon size={22} stroke={STROKE} />
            </button>
          );
        })}
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
            Правка маски задачи #{numbers.current.get(maskJob)}: кисть и фигуры добавляют, ластик и Alt стирают.
            <button onClick={() => setMaskJob(null)}>Готово</button>
          </div>
        )}
        {editedLayer && (
          <div class="stage-banner">
            Маска слоя «{short(editedLayer.prompt)}»: ластик и Alt скрывают, кисть и фигуры возвращают.
            <button onClick={() => setMaskLayer(null)}>Готово</button>
          </div>
        )}
        {!doc && state && <StartScreen recent={state.recent} onOpen={openDialog} onOpenRecent={openRecent} onError={fail} />}
        {(busy ?? state?.activity) && <div class="busy">{busy ?? state?.activity}</div>}
        {toast && <div class={toast.error ? 'toast error' : 'toast'}>{toast.text}</div>}
      </main>

      <aside class="side">
        {state && !state.hasKey && (
          <section class="panel notice">
            <h2>Нужен ключ laozhang.ai</h2>
            <p class="hint">Без него генерация не работает. Ключ вводится один раз в настройках (⌘,) и хранится на этом компьютере.</p>
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
                placeholder="Добавляется к каждой правке: например, «книжная иллюстрация, тёплый вечерний свет»"
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
              <h2>Новая правка</h2>
              <p class={hasSelection ? 'hint ok' : 'hint'}>
                {hasSelection
                  ? `Фигур в выделении: ${selection.length}. Esc сбрасывает выделение, ⌘Z убирает последнюю фигуру.`
                  : 'Выделите область на холсте: прямоугольник, лассо или кисть. Alt стирает лишнее.'}
              </p>
              <textarea
                rows={3}
                placeholder="Опишите, что должно получиться: «рельсы на мосту продолжают колею слева, без разрыва»"
                value={prompt}
                onInput={(e) => setPrompt(e.currentTarget.value)}
              />
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
                    <option value="flash">Nano Banana 2</option>
                    <option value="pro">Nano Banana Pro</option>
                  </select>
                </label>
                <label>
                  Разрешение
                  <select value={size} onChange={(e) => setSize(e.currentTarget.value as SizeChoice)}>
                    <option value="auto">Авто, до 2K</option>
                    <option value="1K">1K</option>
                    <option value="2K">2K</option>
                    <option value="4K">4K, 4–5 мин</option>
                  </select>
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
              <button class="primary" disabled={!canGenerate} onClick={generate} title="⌘↵">
                Сгенерировать {variants} {plural(variants, 'вариант', 'варианта', 'вариантов')}
              </button>
            </section>

            <section class="panel">
              <h2>
                Очередь <span class="dim">{jobs.length || ''}</span>
              </h2>
              {!jobs.length && <p class="hint">Здесь появятся правки, пока вы их не примете или не отклоните.</p>}
              {sortedJobs.map((job) => (
                <JobCard
                  key={job.id}
                  job={job}
                  number={numbers.current.get(job.id) ?? 0}
                  focused={job.id === focusJob}
                  maskMode={job.id === maskJob}
                  onFocus={() => focus(job)}
                  onSwitch={(dir) => switchVariant(job, dir)}
                  onMaskMode={() => {
                    setMaskJob(maskJob === job.id ? null : job.id);
                    setMaskLayer(null);
                    setFocusJob(job.id);
                    if (tool === 'hand') setTool('brush');
                  }}
                  onAction={(action) => {
                    if (action === 'expand') {
                      post<{ addedPx: number }>(`/api/jobs/${job.id}/mask/expand`)
                        .then(({ addedPx }) => {
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
                    post(`/api/jobs/${job.id}/${path}`, action === 'more' ? { count: variants } : undefined).catch(fail);
                  }}
                />
              ))}
            </section>

            <section class="panel">
              <h2>Слои</h2>
              {!layers.length && (
                <p class="hint">Принятые правки ложатся слоями поверх исходника. Глаз скрывает слой, маска стирает его часть или возвращает обратно.</p>
              )}
              <ol class="layers">
                {[...layers].reverse().map((p) => (
                  <LayerItem
                    key={p.id}
                    patch={p}
                    maskMode={p.id === maskLayer}
                    onToggle={() => post(`/api/history/${p.id}/toggle`).catch(fail)}
                    onShow={() => viewRef.current?.showRect(p.rect)}
                    onMask={() => editLayerMask(p)}
                  />
                ))}
              </ol>
            </section>
          </>
        )}
      </aside>

      {dialog === 'settings' && state && (
        <SettingsDialog
          hasKey={state.hasKey}
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
  number: number;
  focused: boolean;
  maskMode: boolean;
  onFocus: () => void;
  onSwitch: (dir: number) => void;
  onMaskMode: () => void;
  onAction: (action: JobAction) => void;
}) {
  const { job } = props;
  const done = job.variants.filter((v) => v.status === 'done');
  const running = job.variants.filter((v) => v.status === 'running').length;
  const selected = job.variants[job.selected];
  const index = done.findIndex((v) => v.n === job.selected);
  const busy = job.status === 'queued' || job.status === 'preparing' || job.status === 'running';

  return (
    <article class={`job ${job.status}${props.focused ? ' focused' : ''}`} onClick={props.onFocus}>
      <header>
        <span class="job-number">#{props.number}</span>
        <p class="job-prompt">{job.prompt}</p>
      </header>
      <p class="job-status">
        {STATUS[job.status]}
        {job.status === 'running' && `, готово ${done.length} из ${job.variants.length}`}
        {busy && `, ${clock(Date.now() - Date.parse(job.createdAt))}`}
        {job.status === 'done' && running > 0 && `, ещё ${running} в работе`}
        {job.modelSize && <span class="dim">, {[job.imageSize, job.model === 'pro' ? 'Pro' : ''].filter(Boolean).join(' ')}</span>}
        {job.refs > 0 && <span class="dim">, референсов: {job.refs}</span>}
      </p>
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
              Вариант {index + 1} из {done.length}
              {selected?.elapsedMs !== undefined && <span class="dim">, {Math.round(selected.elapsedMs / 1000)} с</span>}
            </span>
            <button class="icon" aria-label="Следующий вариант" disabled={done.length < 2} onClick={() => props.onSwitch(1)}>
              <IconChevronRight size={16} stroke={STROKE} />
            </button>
          </div>
          {selected?.insideChangedPct !== undefined && selected.insideChangedPct < 2 && (
            <p class="job-warning">
              В этом варианте модель почти ничего не изменила. Опишите, что должно получиться, а не что исправить, или выделите
              область поменьше.
            </p>
          )}
          <div class="row">
            <button class="primary" onClick={() => props.onAction('accept')}>
              Принять
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

function LayerItem(props: { patch: PatchDto; maskMode: boolean; onToggle: () => void; onShow: () => void; onMask: () => void }) {
  const { patch } = props;
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
      <button class="link" onClick={props.onShow} title="Показать на холсте">
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
    </li>
  );
}

function SettingsDialog(props: { hasKey: boolean; onClose: () => void; onSaved: (text: string) => void; onError: (err: unknown) => void }) {
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
          {props.hasKey
            ? 'Ключ сохранён. Чтобы заменить его, вставьте новый.'
            : 'Без ключа генерация не работает. Вставьте ключ из личного кабинета laozhang.ai.'}
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
          <p class="hint">
            {mac ? 'Хранится в Связке ключей macOS.' : 'Хранится на этом компьютере в зашифрованном виде.'} Обратно в окно
            приложения ключ не попадает и отправляется только в laozhang.ai.
          </p>
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
              <p class="hint">
                PNG, JPEG, WebP или TIFF любого размера либо проект canvaaaas (.caaa) со слоями. Всё вне выделенных областей останется
                нетронутым.
              </p>
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
            <p class="hint">Здесь появятся файлы, которые вы открывали и сохраняли.</p>
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
