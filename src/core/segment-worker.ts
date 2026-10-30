// Поток для SAM: onnxruntime-node считает синхронно, и кодировщик на секунды держал бы поток сервера,
// а в приложении — и главный процесс Electron: не приходили тайлы, окно не отвечало. Здесь лежат сеансы ONNX
// и признаки последних участков; сервер шлёт сюда готовые тензоры и получает маски. Протокол — в segment.ts.
import { parentPort } from 'node:worker_threads';
import ort from 'onnxruntime-node';
import type { Backend, WorkerReply, WorkerRequest } from './segment.ts';

/** Признаков участков держим столько: сервер помнит меньше, поэтому нужные ему здесь всегда есть */
const KEPT = 8;

let enc: ort.InferenceSession | null = null;
let dec: ort.InferenceSession | null = null;
const embeddings = new Map<number, { embed: ort.Tensor; f0: ort.Tensor; f1: ort.Tensor }>();

/** Признаки участка id; обращение делает их свежими */
function embedding(id: number) {
  const e = embeddings.get(id);
  if (!e) throw new Error('Признаки участка устарели: выделите заново');
  embeddings.delete(id);
  embeddings.set(id, e);
  return e;
}

async function load(encoder: string, decoder: string, prefer: Backend): Promise<Backend> {
  const opts = (ep: Backend): ort.InferenceSession.SessionOptions => ({ executionProviders: [ep], logSeverityLevel: 3 });
  let backend: Backend = prefer;
  try {
    enc = await ort.InferenceSession.create(encoder, opts(prefer));
  } catch (err) {
    if (prefer === 'cpu') throw err;
    backend = 'cpu';
    enc = await ort.InferenceSession.create(encoder, opts('cpu'));
  }
  dec = await ort.InferenceSession.create(decoder, opts('cpu'));
  return backend;
}

async function handle(msg: WorkerRequest): Promise<{ reply: WorkerReply; transfer?: ArrayBuffer[] }> {
  switch (msg.type) {
    case 'load':
      return { reply: { seq: msg.seq, backend: await load(msg.encoder, msg.decoder, msg.prefer) } };
    case 'encode': {
      if (!enc) throw new Error('Модель не загружена');
      const out = await enc.run({ image: new ort.Tensor('float32', msg.input, [1, 3, msg.size, msg.size]) });
      embeddings.set(msg.id, { embed: out.image_embed!, f0: out.high_res_feats_0!, f1: out.high_res_feats_1! });
      while (embeddings.size > KEPT) embeddings.delete(embeddings.keys().next().value!);
      return { reply: { seq: msg.seq } };
    }
    case 'decode': {
      if (!dec) throw new Error('Модель не загружена');
      const e = embedding(msg.id);
      const n = msg.labels.length;
      const out = await dec.run({
        image_embed: e.embed,
        high_res_feats_0: e.f0,
        high_res_feats_1: e.f1,
        point_coords: new ort.Tensor('float32', msg.coords, [1, n, 2]),
        point_labels: new ort.Tensor('float32', msg.labels, [1, n]),
        mask_input: new ort.Tensor('float32', msg.hint, [1, 1, msg.low, msg.low]),
        has_mask_input: new ort.Tensor('float32', new Float32Array([msg.hasHint ? 1 : 0]), [1]),
      });
      // Копии: данные тензоров ONNX передать в другой поток нельзя
      const masks = Float32Array.from(out.masks!.data as Float32Array);
      const scores = Float32Array.from(out.iou_predictions!.data as Float32Array);
      return { reply: { seq: msg.seq, masks, dims: [...(out.masks!.dims as number[])], scores }, transfer: [masks.buffer, scores.buffer] };
    }
    case 'touch':
      if (embeddings.has(msg.id)) embedding(msg.id);
      return { reply: { seq: msg.seq } };
  }
}

parentPort!.on('message', (msg: WorkerRequest) => {
  handle(msg).then(
    ({ reply, transfer }) => parentPort!.postMessage(reply, transfer ?? []),
    (err: unknown) => parentPort!.postMessage({ seq: msg.seq, error: err instanceof Error ? err.message : String(err) } satisfies WorkerReply),
  );
});
