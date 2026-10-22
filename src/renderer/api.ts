// Обращения к серверу приложения. Все изменяющие запросы несут заголовок x-canvaaaas.
import { API_HEADER, type StateDto } from '../shared/api.ts';

async function handle<T>(res: Response): Promise<T> {
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Сервер ответил ${res.status}`);
  return data;
}

export function getState(): Promise<StateDto> {
  return fetch('/api/state').then((r) => handle<StateDto>(r));
}

export function post<T = { ok: true }>(path: string, body?: unknown): Promise<T> {
  return fetch(path, {
    method: 'POST',
    headers: { [API_HEADER]: '1', 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }).then((r) => handle<T>(r));
}

export function upload(file: File): Promise<unknown> {
  return fetch(`/api/doc/upload?name=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    headers: { [API_HEADER]: '1', 'Content-Type': 'application/octet-stream' },
    body: file,
  }).then((r) => handle(r));
}

/**
 * Сервер сообщает об изменениях; после каждого сообщения интерфейс перечитывает состояние.
 * Если сервер ещё не поднялся или перезапускается, EventSource сам не переподключится — делаем это вручную.
 */
export function subscribe(onChange: () => void): () => void {
  let events: EventSource | null = null;
  let timer = 0;
  let stopped = false;
  const connect = () => {
    events = new EventSource('/api/events');
    events.onmessage = () => onChange();
    events.onerror = () => {
      if (events?.readyState !== EventSource.CLOSED || stopped) return;
      timer = window.setTimeout(connect, 1500);
    };
  };
  connect();
  return () => {
    stopped = true;
    window.clearTimeout(timer);
    events?.close();
  };
}

export function uploadReference(file: Blob): Promise<{ id: string }> {
  return fetch('/api/refs', {
    method: 'POST',
    headers: { [API_HEADER]: '1', 'Content-Type': 'application/octet-stream' },
    body: file,
  }).then((r) => handle<{ id: string }>(r));
}
