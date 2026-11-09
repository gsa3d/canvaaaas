// Запись PSD и PSB со слоями и группами: 8 бит, RGB, сжатие RLE (его читают все программы, ZIP Фотошоп у готовой картинки
// не принимает). Слои пишутся по одному: длины каналов становятся известны только после сжатия, поэтому место под таблицу
// слоёв занимается заранее (её размер от длин не зависит), а заполняется в конце. В памяти — не больше одного слоя.
import { closeSync, openSync, writeSync } from 'node:fs';
import type { Rect } from './frame.ts';

/** Фотошоп открывает PSD не больше 2 ГБ; дальше — PSB */
export const PSD_MAX_BYTES = 2 ** 31 - 2 ** 20;
export const PSD_MAX_SIDE = 30000;

export type PsdOutLayer =
  | { kind: 'background'; name: string }
  | { kind: 'pixels'; name: string; hidden: boolean }
  | { kind: 'group'; name: string; hidden: boolean }
  | { kind: 'end' };

export interface PsdWriteOptions {
  width: number;
  height: number;
  psb: boolean;
  density?: number;
  icc?: Uint8Array;
  /** Снизу вверх */
  layers: PsdOutLayer[];
}

/** Файл не поместился в PSD: нужен PSB */
export class PsdTooBig extends Error {}

const GROUP_END_NAME = '</Layer group>';
/** Каналы слоя в порядке, в котором они лежат в файле; смещение — в RGBA */
const LAYER_CHANNELS = [
  { id: -1, at: 3 },
  { id: 0, at: 0 },
  { id: 1, at: 1 },
  { id: 2, at: 2 },
];
const BACKGROUND_CHANNELS = LAYER_CHANNELS.slice(1);

function pad(n: number, to: number): number {
  return (n + to - 1) & ~(to - 1);
}

/** Сборка небольших блоков в памяти */
class Bytes {
  private readonly parts: Buffer[] = [];
  length = 0;

  bytes(b: Uint8Array): this {
    this.parts.push(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
    this.length += b.length;
    return this;
  }

  private sized(n: number, write: (b: Buffer) => void): this {
    const b = Buffer.alloc(n);
    write(b);
    return this.bytes(b);
  }

  u8(v: number): this {
    return this.sized(1, (b) => b.writeUInt8(v));
  }

  u16(v: number): this {
    return this.sized(2, (b) => b.writeUInt16BE(v));
  }

  i16(v: number): this {
    return this.sized(2, (b) => b.writeInt16BE(v));
  }

  u32(v: number): this {
    return this.sized(4, (b) => b.writeUInt32BE(v));
  }

  i32(v: number): this {
    return this.sized(4, (b) => b.writeInt32BE(v));
  }

  u64(v: number): this {
    return this.u32(Math.floor(v / 2 ** 32)).u32(v % 2 ** 32);
  }

  text(s: string): this {
    return this.bytes(Buffer.from(s, 'latin1'));
  }

  zeros(n: number): this {
    return this.bytes(Buffer.alloc(n));
  }

  build(): Buffer {
    return Buffer.concat(this.parts, this.length);
  }
}

/** Имя с длиной: латиницей, а настоящее — в блоке luni */
function pascal(name: string): Buffer {
  const ascii = name.replace(/[^\x20-\x7e]/g, '?').slice(0, 255);
  const out = Buffer.alloc(pad(1 + ascii.length, 4));
  out[0] = ascii.length;
  out.write(ascii, 1, 'latin1');
  return out;
}

function unicodeBlock(name: string): Bytes {
  const data = Buffer.from(name, 'utf16le').swap16();
  const size = pad(4 + data.length, 4);
  return new Bytes().text('8BIM').text('luni').u32(size).u32(name.length).bytes(data).zeros(size - 4 - data.length);
}

function sectionBlock(type: number): Bytes {
  const out = new Bytes().text('8BIM').text('lsct');
  return type === 3 ? out.u32(4).u32(type) : out.u32(16).u32(type).text('8BIM').text('pass').u32(0);
}

function resolution(dpi: number): Bytes {
  const fixed = Math.round(dpi * 65536);
  return new Bytes().u32(fixed).u16(1).u16(1).u32(fixed).u16(1).u16(1);
}

function resource(id: number, data: Uint8Array): Bytes {
  return new Bytes()
    .text('8BIM')
    .u16(id)
    .u16(0)
    .u32(data.length)
    .bytes(data)
    .zeros(data.length % 2);
}

/** PackBits одной строки из значений через stride; возвращает новую позицию в out */
function packRow(src: Uint8Array, start: number, stride: number, count: number, out: Uint8Array, at: number): number {
  let pos = at;
  const value = (i: number) => src[start + i * stride]!;
  for (let i = 0; i < count; ) {
    const v = value(i);
    let run = 1;
    while (i + run < count && run < 128 && value(i + run) === v) run++;
    // Повтор из двух не короче двух обычных байт, а заголовок разрывал бы строку: выгодны только от трёх
    if (run >= 3) {
      out[pos++] = 257 - run;
      out[pos++] = v;
      i += run;
      continue;
    }
    let literal = 1;
    while (i + literal < count && literal < 128) {
      const next = value(i + literal);
      if (i + literal + 2 < count && next === value(i + literal + 1) && next === value(i + literal + 2)) break;
      literal++;
    }
    out[pos++] = literal - 1;
    for (let k = 0; k < literal; k++) out[pos++] = value(i + k);
    i += literal;
  }
  return pos;
}

/** Границы непрозрачного; null — слой пуст */
function opaqueBounds(rgba: Uint8Array, w: number, h: number): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0, i = 3; y < h; y++) {
    for (let x = 0; x < w; x++, i += 4) {
      if (rgba[i] === 0) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      y1 = y;
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

interface Written {
  layer: PsdOutLayer;
  rect: { top: number; left: number; bottom: number; right: number };
  lengths: number[];
}

export class PsdWriter {
  private readonly opts: PsdWriteOptions;
  private readonly fd: number;
  private pos = 0;
  private readonly sectionLengthAt: number;
  private readonly infoLengthAt: number;
  private readonly recordsAt: number;
  private readonly written: Written[] = [];
  private next = 0;
  private closed = false;

  constructor(path: string, opts: PsdWriteOptions) {
    this.opts = opts;
    this.fd = openSync(path, 'w');
    const resources = new Bytes();
    if (opts.density) resources.bytes(resource(1005, resolution(opts.density).build()).build());
    if (opts.icc) resources.bytes(resource(1039, opts.icc).build());
    const head = new Bytes()
      .text('8BPS')
      .u16(opts.psb ? 2 : 1)
      .zeros(6)
      .u16(3)
      .u32(opts.height)
      .u32(opts.width)
      .u16(8)
      .u16(3)
      .u32(0)
      .u32(resources.length)
      .bytes(resources.build());
    this.write(head.build());
    this.sectionLengthAt = this.pos;
    this.pos += this.lengthSize;
    this.infoLengthAt = this.pos;
    this.pos += this.lengthSize;
    this.recordsAt = this.pos;
    // Размер записей не зависит от длин каналов, их тут ещё нет
    this.pos += 2 + opts.layers.reduce((sum, layer) => sum + this.record({ layer, rect: { top: 0, left: 0, bottom: 0, right: 0 }, lengths: this.channelsOf(layer).map(() => 0) }).length, 0);
    this.advance();
  }

  private get lengthSize(): number {
    return this.opts.psb ? 8 : 4;
  }

  private write(data: Uint8Array, at = this.pos): void {
    for (let done = 0; done < data.length; ) done += writeSync(this.fd, data, done, Math.min(data.length - done, 1 << 30), at + done);
    if (at === this.pos) this.pos += data.length;
  }

  private channelsOf(layer: PsdOutLayer): typeof LAYER_CHANNELS {
    return layer.kind === 'background' ? BACKGROUND_CHANNELS : LAYER_CHANNELS;
  }

  private record(w: Written): Buffer {
    const { layer, rect, lengths } = w;
    const channels = this.channelsOf(layer);
    const out = new Bytes().i32(rect.top).i32(rect.left).i32(rect.bottom).i32(rect.right).u16(channels.length);
    channels.forEach((c, i) => {
      out.i16(c.id);
      if (this.opts.psb) out.u64(lengths[i]!);
      else out.u32(lengths[i]!);
    });
    const name = layer.kind === 'end' ? GROUP_END_NAME : layer.name;
    const section = layer.kind === 'end' || layer.kind === 'group';
    const hidden = layer.kind !== 'end' && layer.kind !== 'background' && layer.hidden;
    // 0x08 — Фотошоп 5 и новее; 0x10 — у разделителей групп пикселей нет; 0x01 — фон без прозрачности
    const flags = 0x08 | (section ? 0x10 : 0) | (hidden ? 0x02 : 0) | (layer.kind === 'background' ? 0x01 : 0);
    out.text('8BIM').text(layer.kind === 'group' || layer.kind === 'end' ? 'pass' : 'norm').u8(255).u8(0).u8(flags).u8(0);
    const extra = new Bytes().u32(0).u32(32);
    for (let i = 0; i < 8; i++) extra.u32(0xffff);
    extra.bytes(pascal(name)).bytes(unicodeBlock(name).build());
    if (layer.kind === 'group') extra.bytes(sectionBlock(1).build());
    if (layer.kind === 'end') extra.bytes(sectionBlock(3).build());
    return out.u32(extra.length).bytes(extra.build()).build();
  }

  private fits(): void {
    if (!this.opts.psb && this.pos > PSD_MAX_BYTES) throw new PsdTooBig();
  }

  /** Сжатый канал: сжатие, длины строк, строки */
  private channel(src: Uint8Array, start: number, stride: number, w: number, h: number): number {
    const table = this.opts.psb ? 4 : 2;
    const out = Buffer.allocUnsafeSlow(2 + h * table + h * (w + (w >> 6) + 4));
    out.writeUInt16BE(1, 0);
    let pos = 2 + h * table;
    for (let row = 0; row < h; row++) {
      const end = packRow(src, start + row * w * stride, stride, w, out, pos);
      if (this.opts.psb) out.writeUInt32BE(end - pos, 2 + row * 4);
      else out.writeUInt16BE(end - pos, 2 + row * 2);
      pos = end;
    }
    this.write(out.subarray(0, pos));
    this.fits();
    return pos;
  }

  /** Разделители групп пикселей не имеют и пишутся сами, между слоями с картинкой */
  private advance(): void {
    for (let layer = this.opts.layers[this.next]; layer && (layer.kind === 'group' || layer.kind === 'end'); layer = this.opts.layers[++this.next]) {
      const lengths = LAYER_CHANNELS.map(() => {
        this.write(Buffer.alloc(2));
        return 2;
      });
      this.written.push({ layer, rect: { top: 0, left: 0, bottom: 0, right: 0 }, lengths });
    }
  }

  /** Следующий слой с картинкой снизу: фон — RGB на весь холст, слой — RGBA размером с rect */
  addLayer(pixels: Uint8Array, rect: Rect): void {
    const layer = this.opts.layers[this.next];
    if (!layer || layer.kind === 'group' || layer.kind === 'end') throw new Error('PSD: лишний слой');
    this.next++;
    if (layer.kind === 'background') {
      const lengths = BACKGROUND_CHANNELS.map((c) => this.channel(pixels, c.at, 3, rect.width, rect.height));
      this.written.push({ layer, rect: { top: 0, left: 0, bottom: rect.height, right: rect.width }, lengths });
    } else {
      const box = opaqueBounds(pixels, rect.width, rect.height);
      if (!box) {
        const lengths = LAYER_CHANNELS.map(() => {
          this.write(Buffer.alloc(2));
          return 2;
        });
        this.written.push({ layer, rect: { top: 0, left: 0, bottom: 0, right: 0 }, lengths });
      } else {
        const w = box.x1 - box.x0 + 1;
        const h = box.y1 - box.y0 + 1;
        const from = (box.y0 * rect.width + box.x0) * 4;
        // Строки обрезанного слоя идут с шагом целого, поэтому канал пишется построчно из копии без лишнего
        const cut = new Uint8Array(w * h * 4);
        for (let y = 0; y < h; y++) {
          const at = from + y * rect.width * 4;
          cut.set(pixels.subarray(at, at + w * 4), y * w * 4);
        }
        const lengths = LAYER_CHANNELS.map((c) => this.channel(cut, c.at, 4, w, h));
        this.written.push({ layer, rect: { top: rect.y + box.y0, left: rect.x + box.x0, bottom: rect.y + box.y1 + 1, right: rect.x + box.x1 + 1 }, lengths });
      }
    }
    this.advance();
  }

  private writeLength(at: number, value: number): void {
    this.write(this.opts.psb ? new Bytes().u64(value).build() : new Bytes().u32(value).build(), at);
  }

  /** Готовая картинка всего файла (RGB) и таблица слоёв */
  finish(composite: Uint8Array): void {
    const { width, height, layers } = this.opts;
    if (this.written.length !== layers.length) throw new Error('PSD: записаны не все слои');
    const records = new Bytes().i16(layers.length);
    for (const w of this.written) records.bytes(this.record(w));
    this.write(records.build(), this.recordsAt);
    // Длина блока слоёв — кратная 4, с нулями в конце
    const infoEnd = this.infoLengthAt + this.lengthSize + pad(this.pos - this.infoLengthAt - this.lengthSize, 4);
    this.write(Buffer.alloc(infoEnd - this.pos));
    this.writeLength(this.infoLengthAt, infoEnd - this.infoLengthAt - this.lengthSize);
    this.write(Buffer.alloc(4));
    this.writeLength(this.sectionLengthAt, this.pos - this.sectionLengthAt - this.lengthSize);

    // Готовая картинка: сжатие, длины всех строк всех каналов, строки. Её читают программы, которым слои не нужны
    this.write(new Bytes().u16(1).build());
    const entry = this.opts.psb ? 4 : 2;
    const tableAt = this.pos;
    const table = Buffer.alloc(height * 3 * entry);
    this.pos += table.length;
    const row = Buffer.allocUnsafeSlow(width + (width >> 6) + 4);
    const batch = Buffer.allocUnsafeSlow(Math.max(1 << 22, row.length));
    let filled = 0;
    const flush = () => {
      this.write(batch.subarray(0, filled));
      filled = 0;
    };
    for (let c = 0; c < 3; c++) {
      for (let y = 0; y < height; y++) {
        const size = packRow(composite, y * width * 3 + c, 3, width, row, 0);
        if (this.opts.psb) table.writeUInt32BE(size, (c * height + y) * 4);
        else table.writeUInt16BE(size, (c * height + y) * 2);
        if (filled + size > batch.length) flush();
        row.copy(batch, filled, 0, size);
        filled += size;
      }
      flush();
      this.fits();
    }
    this.write(table, tableAt);
    this.close();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeSync(this.fd);
  }
}
