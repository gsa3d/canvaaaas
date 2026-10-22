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

/** Сервер сообщает об изменениях; после каждого сообщения интерфейс перечитывает состояние */
export function subscribe(onChange: () => void): () => void {
  const events = new EventSource('/api/events');
  events.onmessage = () => onChange();
  return () => events.close();
}
