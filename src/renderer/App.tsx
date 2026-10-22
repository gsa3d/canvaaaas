import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  COMMAND_EVENT,
  MAX_REFERENCES,
  type AppCommand,
  type JobDto,
  type MaskShape,
  type ModelChoice,
  type PatchDto,
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

function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const ICONS: Record<Tool, ComponentChildren> = {
  hand: <path d="M10 2v16M2 10h16M10 2 7.5 4.5M10 2l2.5 2.5M10 18l-2.5-2.5M10 18l2.5-2.5M2 10l2.5-2.5M2 10l2.5 2.5M18 10l-2.5-2.5M18 10l-2.5 2.5" />,
  rect: <rect x="3" y="5" width="14" height="10" rx="1" stroke-dasharray="2.5 2" />,
  lasso: <path d="M5.5 13C3.6 12 2.5 10.4 2.5 8.6 2.5 5.3 6 3 10.2 3s7.3 2.2 7.3 5.2-3.3 5-7.3 5c-1.6 0-3.4 0-4.6.6-1 .5-1.3 1.6-.6 2.4.9 1 2.6.9 3.3-.3" />,
  brush: <circle cx="10" cy="10" r="5.5" fill="currentColor" />,
  eraser: (
    <>
      <circle cx="10" cy="10" r="5.5" />
      <path d="M6.2 13.8 13.8 6.2" />
    </>
  ),
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
  const [selection, setSelection] = useState<MaskShape[]>([]);
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState<ModelChoice>('flash');
  const [size, setSize] = useState<SizeChoice>('auto');
  const [variants, setVariants] = useState(2);
  const [focusJob, setFocusJob] = useState<string | null>(null);
  const [maskJob, setMaskJob] = useState<string | null>(null);
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
    setStyleDraft(doc?.style ?? '');
    setSelection([]);
    setMaskJob(null);
  }, [doc?.id]);
  useEffect(() => {
    if (maskJob && !jobs.some((j) => j.id === maskJob && j.status === 'done')) setMaskJob(null);
    viewRef.current?.setJobs(jobs, numbers.current, focusJob, maskJob);
  }, [state?.jobs, focusJob, maskJob]);
  useEffect(() => viewRef.current?.setSelection(selection), [selection]);
  useEffect(() => viewRef.current?.setTool(tool), [tool]);
  useEffect(() => viewRef.current?.setBrush(brush), [brush]);

  const anyRunning = jobs.some((j) => j.status !== 'done' && j.status !== 'error');
  useEffect(() => {
    if (!anyRunning) return;
    const t = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [anyRunning]);

  onShape.current = (shape) => {
    if (maskJob) post(`/api/jobs/${maskJob}/mask`, { shapes: [shape] }).catch(fail);
    else setSelection((s) => [...s, shape]);
  };

  const hasSelection = selection.some((s) => !s.erase);
  const canGenerate = !!doc && hasSelection && prompt.trim().length > 0 && !maskJob;

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

  const undo = () => {
    if (maskJob) post(`/api/jobs/${maskJob}/mask/undo`).catch(fail);
    else if (selection.length) setSelection((s) => s.slice(0, -1));
    else if (state?.canUndo) post('/api/history/undo').catch(fail);
  };
  const redo = () => {
    if (state?.canRedo) post('/api/history/redo').catch(fail);
  };

  const exportPng = () => {
    if (!doc) return;
    const a = document.createElement('a');
    a.href = '/api/doc/export.png';
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
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
        fileRef.current?.click();
        break;
      case 'new':
        setDialog('new');
        break;
      case 'export':
        exportPng();
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
        '0': 'zoom-fit',
        '1': 'zoom-100',
        '2': 'zoom-50',
        '=': 'zoom-in',
        '+': 'zoom-in',
        '-': 'zoom-out',
      };
      const command = e.shiftKey && key === 'e' ? 'export' : e.shiftKey || e.altKey ? undefined : byKey[key];
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
    if (e.key === '[') setBrush((b) => Math.max(4, Math.round(b / 1.25)));
    if (e.key === ']') setBrush((b) => Math.min(400, Math.round(b * 1.25)));
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

  const focus = (job: JobDto) => {
    setFocusJob(job.id);
    const r = job.inside ?? job.bbox;
    if (r) viewRef.current?.showRect(r);
  };

  const sortedJobs = [...jobs].sort((a, b) => (numbers.current.get(b.id) ?? 0) - (numbers.current.get(a.id) ?? 0));

  return (
    <div class="app">
      <header class="topbar">
        <div class="doc-title">
          {doc ? (
            <>
              <strong>{doc.name}</strong>
              <span class="dim">
                {doc.width}×{doc.height}
              </span>
            </>
          ) : (
            <strong>canvaaaas</strong>
          )}
        </div>
        <div class="topbar-actions">
          <button class="ghost" onClick={() => fileRef.current?.click()}>
            Открыть…
          </button>
          {doc && (
            <>
              <span class="sep" />
              <button class="ghost" title="Отменить (⌘Z)" disabled={!state?.canUndo && !selection.length && !maskJob} onClick={undo}>
                Отменить
              </button>
              <button class="ghost" title="Повторить (⇧⌘Z)" disabled={!state?.canRedo} onClick={redo}>
                Повторить
              </button>
              <span class="sep" />
              <div class="zoom-control">
                <button class="ghost icon" title="Уменьшить (⌘−)" aria-label="Уменьшить" onClick={() => run('zoom-out')}>
                  −
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
                  +
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
              <button class="ghost" title="Сохранить PNG в полном разрешении (⇧⌘E)" onClick={exportPng}>
                Сохранить PNG
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
        {TOOLS.map((t) => (
          <button
            key={t.id}
            class={tool === t.id ? 'tool active' : 'tool'}
            title={`${t.label} (${t.key})`}
            aria-pressed={tool === t.id}
            onClick={() => setTool(t.id)}
          >
            <svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              {ICONS[t.id]}
            </svg>
          </button>
        ))}
        {(tool === 'brush' || tool === 'eraser') && (
          <label class="brush-size" title="Размер кисти на экране ([ и ])">
            <input type="range" min={4} max={400} value={brush} onInput={(e) => setBrush(Number(e.currentTarget.value))} />
            <span>{brush}</span>
          </label>
        )}
      </nav>

      <main class={maskJob ? 'stage mask-mode' : 'stage'}>
        <div ref={stageRef} class="osd" />
        {maskJob && (
          <div class="stage-banner">
            Правка маски задачи #{numbers.current.get(maskJob)}: кисть и фигуры добавляют, ластик и Alt стирают.
            <button onClick={() => setMaskJob(null)}>Готово</button>
          </div>
        )}
        {!doc && <EmptyState onOpen={() => fileRef.current?.click()} onError={fail} />}
        {busy && <div class="busy">{busy}</div>}
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
                      ×
                    </button>
                  </figure>
                ))}
                {refs.length < MAX_REFERENCES && (
                  <button class="ref-add" title="Или перетащите картинку сюда, или вставьте её через ⌘V" onClick={() => refRef.current?.click()}>
                    + Референс
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
              <h2>История</h2>
              {!state?.history.length && <p class="hint">Принятые правки. Любую можно выключить и включить обратно.</p>}
              <ol class="history">
                {[...(state?.history ?? [])].reverse().map((p) => (
                  <HistoryItem key={p.id} patch={p} onToggle={() => post(`/api/history/${p.id}/toggle`).catch(fail)} onShow={() => viewRef.current?.showRect(p.rect)} />
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
          <div class="modal" role="dialog" aria-modal="true" aria-labelledby="new-title" onClick={(e) => e.stopPropagation()}>
            <h2 id="new-title">Новый холст</h2>
            {doc && <p class="hint">Текущий документ закроется вместе с непринятыми правками.</p>}
            <NewCanvasForm
              primary
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
        accept="image/png,image/jpeg,image/webp,image/tiff"
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
              ‹
            </button>
            <span>
              Вариант {index + 1} из {done.length}
              {selected?.elapsedMs !== undefined && <span class="dim">, {Math.round(selected.elapsedMs / 1000)} с</span>}
            </span>
            <button class="icon" aria-label="Следующий вариант" disabled={done.length < 2} onClick={() => props.onSwitch(1)}>
              ›
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
            <button class="icon" title="Отменить правку маски" disabled={!job.canUndoMask} onClick={() => props.onAction('undoMask')}>
              ↶
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

function HistoryItem(props: { patch: PatchDto; onToggle: () => void; onShow: () => void }) {
  const { patch } = props;
  const time = new Date(patch.createdAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return (
    <li class={patch.active ? '' : 'off'}>
      <button class="link" onClick={props.onShow} title="Показать на холсте">
        {patch.prompt}
      </button>
      <span class="dim">{time}</span>
      <button class="small" onClick={props.onToggle}>
        {patch.active ? 'Выключить' : 'Включить'}
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

function NewCanvasForm(props: { onError: (err: unknown) => void; onCreated?: () => void; extra?: ComponentChildren; primary?: boolean }) {
  const [width, setWidth] = useState(4096);
  const [height, setHeight] = useState(3072);
  const [color, setColor] = useState('#ffffff');
  return (
    <form
      class="new-canvas"
      onSubmit={(e) => {
        e.preventDefault();
        post('/api/doc/new', { width, height, color })
          .then(() => props.onCreated?.())
          .catch(props.onError);
      }}
    >
      <label>
        Ширина
        <input type="number" min={16} max={30000} value={width} onInput={(e) => setWidth(Number(e.currentTarget.value))} />
      </label>
      <label>
        Высота
        <input type="number" min={16} max={30000} value={height} onInput={(e) => setHeight(Number(e.currentTarget.value))} />
      </label>
      <label>
        Фон
        <input type="color" value={color} onInput={(e) => setColor(e.currentTarget.value)} />
      </label>
      <button type="submit" class={props.primary ? 'primary' : ''}>
        Создать холст
      </button>
      {props.extra}
    </form>
  );
}

function EmptyState(props: { onOpen: () => void; onError: (err: unknown) => void }) {
  return (
    <div class="empty">
      <h1>Откройте картинку или начните с пустого холста</h1>
      <p>PNG, JPEG, WebP или TIFF любого размера. Всё, что вне выделенных областей, останется нетронутым.</p>
      <button class="primary" onClick={props.onOpen}>
        Открыть картинку…
      </button>
      <NewCanvasForm onError={props.onError} />
    </div>
  );
}
