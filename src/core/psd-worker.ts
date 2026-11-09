// Поток PSD: разбор и сжатие слоёв считаются синхронно и держали бы главный процесс Electron, где живёт сервер: окно замирало
// бы на всё время импорта. Протокол — в psd.ts.
import { parentPort, workerData } from 'node:worker_threads';
import type { PsdReply, PsdRequest } from './psd.ts';
import { PsdFile } from './psd-read.ts';
import { PsdTooBig, PsdWriter } from './psd-write.ts';
import { langOf, setLang } from '../shared/i18n.ts';

setLang(langOf((workerData as { lang?: string } | null)?.lang));

const port = parentPort!;
let reading: PsdFile | null = null;
let writing: PsdWriter | null = null;

function reply(message: PsdReply, transfer: ArrayBuffer[] = []): void {
  port.postMessage(message, transfer);
}

function handle(msg: PsdRequest): void {
  switch (msg.type) {
    case 'open':
      reading = PsdFile.open(msg.path);
      reply({ type: 'summary', summary: reading.summary(), groups: reading.groups() });
      return;
    case 'read': {
      const psd = reading!;
      const base = psd.readBase();
      reply({ type: 'base', base }, [base.buffer as ArrayBuffer]);
      for (const layer of psd.layers({ skipHidden: msg.skipHidden })) {
        reply({ type: 'layer', layer }, [layer.rgba.buffer as ArrayBuffer, layer.alpha.buffer as ArrayBuffer, layer.object.mask.buffer as ArrayBuffer]);
      }
      psd.close();
      reading = null;
      reply({ type: 'done' });
      return;
    }
    case 'write-start':
      writing = new PsdWriter(msg.path, msg.options);
      reply({ type: 'ready' });
      return;
    case 'write-layer':
      writing!.addLayer(msg.pixels, msg.rect);
      reply({ type: 'ready' });
      return;
    case 'write-end':
      writing!.finish(msg.composite);
      writing = null;
      reply({ type: 'done' });
      return;
  }
}

port.on('message', (msg: PsdRequest) => {
  try {
    handle(msg);
  } catch (err) {
    writing?.close();
    writing = null;
    if (err instanceof PsdTooBig) reply({ type: 'too-big' });
    else reply({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
});
