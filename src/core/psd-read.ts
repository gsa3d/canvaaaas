// Чтение PSD и PSB. Файл не грузится в память: таблица слоёв читается кусками, пиксели — слой за слоем по смещениям,
// поэтому поверх документа в памяти лежит не больше одного слоя. Считается в потоке (psd-worker.ts).
// Берутся слои с пикселями и смарт-объекты (в файле лежит их готовая картинка). Текст, векторные фигуры, заливки,
// корректирующие слои и эффекты пропускаются. Холст canvaaaas — обычные слои с альфой, поэтому непрозрачность, растровая
// и обтравочная маски запекаются в альфу, а Multiply и родственные режимы, где белое не видно, — в прозрачность белого.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import type { Rect } from './frame.ts';
import { iccDescription } from './icc.ts';
import { L } from '../shared/i18n.ts';

const MAX_SIDE = 300000;
/** В PSB у этих блоков 8-байтная длина, даже при подписи 8BIM */
const LARGE_KEYS = new Set(['LMsk', 'Lr16', 'Lr32', 'Layr', 'Mt16', 'Mt32', 'Mtrn', 'Alph', 'FMsk', 'lnk2', 'FEid', 'FXid', 'PxSD']);
const TEXT_KEYS = ['TySh', 'tySh'];
const SMART_KEYS = ['SoLd', 'SoLE', 'PlLd', 'plLd'];
const VECTOR_KEYS = ['SoCo', 'GdFl', 'PtFl', 'vstk'];
const ADJUSTMENT_KEYS = ['brit', 'levl', 'curv', 'expA', 'vibA', 'hue ', 'hue2', 'blnc', 'blwh', 'phfl', 'mixr', 'clrL', 'nvrt', 'post', 'thrs', 'grdm', 'selc'];
/** Режимы, где белое не меняет того, что под слоем: белое становится прозрачным */
const DARKENING = new Set(['mul ', 'dark', 'idiv', 'lbrn', 'dkCl']);
/** Режимы, которые на холсте выглядят как есть */
const EXACT = new Set(['norm', 'pass', 'mul ']);

const GRAYSCALE = 1;
const RGB = 3;
const MODE_NAMES: Record<number, string> = { 0: 'Bitmap', 2: 'Indexed', 4: 'CMYK', 7: 'Multichannel', 8: 'Duotone', 9: 'Lab' };

type Kind = 'pixels' | 'smart' | 'text' | 'vector' | 'adjustment' | 'group' | 'end';

interface Bounds {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

interface Channel {
  id: number;
  length: number;
  offset: number;
}

interface MaskInfo extends Bounds {
  fill: number;
  disabled: boolean;
  /** Маска отрисована из вектора: вектор не берём */
  fromVector: boolean;
  /** Растровая маска слоя, у которого есть ещё и векторная */
  real?: Bounds & { fill: number; disabled: boolean };
}

interface PsdRecord extends Bounds {
  name: string;
  channels: Channel[];
  blend: string;
  opacity: number;
  fill: number;
  clipping: boolean;
  hidden: boolean;
  mask?: MaskInfo;
  kind: Kind;
  /** Группа, в которой лежит слой: номер её записи */
  parent: number | null;
}

interface LoadedMask extends Bounds {
  data: Uint8Array;
  fill: number;
}

/** Что есть в файле: по этому видно, сколько памяти нужно, ещё до чтения пикселей */
export interface PsdSummary {
  width: number;
  height: number;
  density?: number;
  /** Цветовой профиль файла, если это не sRGB: холст в sRGB, цвета читаются как есть */
  profile?: string;
  layers: number;
  /** Сколько из них скрыто (сами или группой) */
  hidden: number;
  /** Сколько памяти займёт документ */
  bytes: number;
  /** То же без скрытых слоёв */
  visibleBytes: number;
  text: number;
  vector: number;
  adjustment: number;
  /** У скольких слоёв режим наложения заменён обычным */
  blend: number;
}

export interface PsdLayer {
  name: string;
  rect: Rect;
  rgba: Uint8Array;
  alpha: Uint8Array;
  /** Область слоя: то, что в нём заметно */
  object: { rect: Rect; mask: Uint8Array };
  hidden: boolean;
  group: number | null;
}

export interface PsdGroup {
  id: number;
  name: string;
  hidden: boolean;
  parent: number | null;
}

function broken(why: string): Error {
  return new Error(L(`Не прочитать PSD: ${why}`, `Cannot read the PSD: ${why}`));
}

function truncated(): Error {
  return broken(L('файл обрезан', 'the file is truncated'));
}

/** a·b/255 с округлением */
function mul(a: number, b: number): number {
  const v = a * b + 128;
  return (v + (v >> 8)) >> 8;
}

/** Чтение файла окном: таблица слоёв читается мелкими кусками, а файл бывает на гигабайты */
class Reader {
  readonly size: number;
  pos = 0;
  private readonly fd: number;
  private window: Buffer = Buffer.alloc(0);
  private start = 0;

  constructor(fd: number) {
    this.fd = fd;
    this.size = fstatSync(fd).size;
  }

  block(offset: number, length: number): Buffer {
    if (offset < 0 || offset + length > this.size) throw truncated();
    const out = Buffer.allocUnsafeSlow(length);
    for (let done = 0; done < length; ) {
      const n = readSync(this.fd, out, done, Math.min(length - done, 1 << 30), offset + done);
      if (n <= 0) throw truncated();
      done += n;
    }
    return out;
  }

  private at(n: number): number {
    const inside = this.pos - this.start;
    if (inside >= 0 && inside + n <= this.window.length) return inside;
    if (this.pos + n > this.size) throw truncated();
    this.window = this.block(this.pos, Math.min(Math.max(n, 1 << 20), this.size - this.pos));
    this.start = this.pos;
    return 0;
  }

  u8(): number {
    const v = this.window[this.at(1)]!;
    this.pos += 1;
    return v;
  }

  u16(): number {
    const v = this.window.readUInt16BE(this.at(2));
    this.pos += 2;
    return v;
  }

  i16(): number {
    const v = this.window.readInt16BE(this.at(2));
    this.pos += 2;
    return v;
  }

  u32(): number {
    const v = this.window.readUInt32BE(this.at(4));
    this.pos += 4;
    return v;
  }

  i32(): number {
    const v = this.window.readInt32BE(this.at(4));
    this.pos += 4;
    return v;
  }

  u64(): number {
    const high = this.u32();
    return high * 2 ** 32 + this.u32();
  }

  length(psb: boolean): number {
    return psb ? this.u64() : this.u32();
  }

  text(n: number): string {
    const at = this.at(n);
    this.pos += n;
    return this.window.toString('latin1', at, at + n);
  }

  skip(n: number): void {
    this.pos += n;
  }

  bounds(): Bounds {
    const top = this.i32();
    const left = this.i32();
    const bottom = this.i32();
    const right = this.i32();
    return { top, left, bottom, right };
  }
}

function parseMask(r: Reader, end: number): MaskInfo {
  const bounds = r.bounds();
  const fill = r.u8();
  const flags = r.u8();
  const mask: MaskInfo = { ...bounds, fill, disabled: (flags & 2) !== 0, fromVector: (flags & 8) !== 0 };
  if (flags & 16) {
    const params = r.u8();
    if (params & 1) r.skip(1);
    if (params & 2) r.skip(8);
    if (params & 4) r.skip(1);
    if (params & 8) r.skip(8);
  }
  if (end - r.pos >= 18) {
    const realFlags = r.u8();
    const realFill = r.u8();
    mask.real = { ...r.bounds(), fill: realFill, disabled: (realFlags & 2) !== 0 };
  }
  return mask;
}

function kindOf(keys: Set<string>, section: number): Kind {
  const has = (list: string[]) => list.some((k) => keys.has(k));
  if (section === 1 || section === 2) return 'group';
  if (section === 3) return 'end';
  if (has(TEXT_KEYS)) return 'text';
  if (has(SMART_KEYS)) return 'smart';
  if (has(ADJUSTMENT_KEYS)) return 'adjustment';
  if (has(VECTOR_KEYS)) return 'vector';
  return 'pixels';
}

function parseRecord(r: Reader, psb: boolean): PsdRecord {
  const bounds = r.bounds();
  const count = r.u16();
  const channels: Channel[] = [];
  for (let i = 0; i < count; i++) {
    const id = r.i16();
    channels.push({ id, length: r.length(psb), offset: 0 });
  }
  if (r.text(4) !== '8BIM') throw broken(L('повреждена таблица слоёв', 'the layer table is damaged'));
  const blend = r.text(4);
  const opacity = r.u8();
  const clipping = r.u8() === 1;
  const flags = r.u8();
  r.skip(1);
  const extraLength = r.u32();
  const extraEnd = r.pos + extraLength;
  const maskLength = r.u32();
  const maskEnd = r.pos + maskLength;
  const mask = maskLength >= 18 ? parseMask(r, maskEnd) : undefined;
  r.pos = maskEnd;
  const ranges = r.u32();
  r.skip(ranges);
  const nameLength = r.u8();
  let name = r.text(nameLength);
  // Имя с длиной выровнено по 4 байта
  r.skip(((nameLength + 4) & ~3) - (nameLength + 1));

  const keys = new Set<string>();
  let section = 0;
  let fill = 255;
  while (extraEnd - r.pos >= 12) {
    const signature = r.text(4);
    if (signature !== '8BIM' && signature !== '8B64') {
      // Программы выравнивают эти блоки по-разному: подпись ищется побайтно
      r.pos -= 3;
      continue;
    }
    const key = r.text(4);
    const length = signature === '8B64' || (psb && LARGE_KEYS.has(key)) ? r.u64() : r.u32();
    const data = r.pos;
    if (length > extraEnd - data) break;
    keys.add(key);
    if (key === 'luni' && length >= 4) {
      const chars = Math.min(r.u32(), (length - 4) >> 1);
      name = r.block(r.pos, chars * 2).swap16().toString('utf16le').replace(/\0+$/, '');
    } else if ((key === 'lsct' || key === 'lsdk') && length >= 4) {
      section = r.u32();
    } else if (key === 'iOpa' && length >= 1) {
      fill = r.u8();
    }
    r.pos = data + length;
  }
  r.pos = extraEnd;
  return { ...bounds, name: name.trim(), channels, blend, opacity, fill, clipping, hidden: (flags & 2) !== 0, mask, kind: kindOf(keys, section), parent: null };
}

/** Слои в файле идут снизу вверх: группа начинается концом (end) и кончается заголовком */
function linkGroups(records: PsdRecord[]): void {
  const stack: number[] = [];
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]!;
    if (r.kind === 'end') {
      stack.pop();
      continue;
    }
    r.parent = stack[stack.length - 1] ?? null;
    if (r.kind === 'group') stack.push(i);
  }
}

function parseLayers(r: Reader, psb: boolean): PsdRecord[] {
  const count = Math.abs(r.i16());
  const records: PsdRecord[] = [];
  for (let i = 0; i < count; i++) records.push(parseRecord(r, psb));
  for (const rec of records) {
    for (const ch of rec.channels) {
      ch.offset = r.pos;
      r.skip(ch.length);
    }
  }
  linkGroups(records);
  return records;
}

/** PackBits одной строки */
function unpackBits(src: Buffer, from: number, end: number, dst: Uint8Array, to: number, length: number): void {
  let s = from;
  let d = to;
  const stop = to + length;
  while (s < end && d < stop) {
    const h = src[s++]!;
    if (h < 128) {
      const n = Math.min(h + 1, stop - d, end - s);
      dst.set(src.subarray(s, s + n), d);
      s += h + 1;
      d += n;
    } else if (h > 128) {
      const n = Math.min(257 - h, stop - d);
      dst.fill(src[s++]!, d, d + n);
      d += n;
    }
  }
}

function unpackRows(table: Buffer, tableAt: number, rows: number, psb: boolean, data: Buffer, dataAt: number, rowBytes: number): Uint8Array {
  const out = new Uint8Array(rows * rowBytes);
  let s = dataAt;
  for (let row = 0; row < rows; row++) {
    const n = psb ? table.readUInt32BE(tableAt + row * 4) : table.readUInt16BE(tableAt + row * 2);
    if (s + n > data.length) throw truncated();
    unpackBits(data, s, s + n, out, row * rowBytes, rowBytes);
    s += n;
  }
  return out;
}

/** Строки ZIP с предсказанием хранят разности соседних отсчётов */
function unpredict(data: Uint8Array, rowBytes: number, rows: number, depth: number): void {
  if (depth === 16) {
    for (let row = 0; row < rows; row++) {
      for (let i = row * rowBytes + 2, end = (row + 1) * rowBytes; i < end; i += 2) {
        const v = ((data[i - 2]! << 8) + data[i - 1]! + (data[i]! << 8) + data[i + 1]!) & 0xffff;
        data[i] = v >> 8;
        data[i + 1] = v & 255;
      }
    }
  } else {
    for (let row = 0; row < rows; row++) {
      for (let i = row * rowBytes + 1, end = (row + 1) * rowBytes; i < end; i++) data[i] = (data[i]! + data[i - 1]!) & 255;
    }
  }
}

function to8Bit(data: Uint8Array, depth: number): Uint8Array {
  if (depth === 8) return data;
  const out = new Uint8Array(data.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = data[i * 2]!;
  return out;
}

function intersect(r: Bounds, width: number, height: number): Rect | null {
  const x = Math.max(r.left, 0);
  const y = Math.max(r.top, 0);
  const w = Math.min(r.right, width) - x;
  const h = Math.min(r.bottom, height) - y;
  return w > 0 && h > 0 ? { x, y, width: w, height: h } : null;
}

export class PsdFile {
  readonly width: number;
  readonly height: number;
  readonly density: number | undefined;
  readonly profile: string | undefined;
  private readonly records: PsdRecord[];
  /** Нижний слой без прозрачности на весь холст: он становится исходником, а не слоем */
  private readonly background: PsdRecord | null;
  private readonly depth: number;
  private readonly mode: number;
  private readonly psb: boolean;
  private readonly channels: number;
  private readonly mergedAt: number;
  private readonly fd: number;
  private readonly reader: Reader;
  private readonly groupMasks = new Map<number, LoadedMask | null>();

  private constructor(fd: number) {
    this.fd = fd;
    const r = (this.reader = new Reader(fd));
    if (r.size < 26 || r.text(4) !== '8BPS') throw broken(L('это не PSD', 'this is not a PSD file'));
    const version = r.u16();
    if (version !== 1 && version !== 2) throw broken(L(`неизвестная версия ${version}`, `unknown version ${version}`));
    this.psb = version === 2;
    r.skip(6);
    this.channels = r.u16();
    this.height = r.u32();
    this.width = r.u32();
    this.depth = r.u16();
    this.mode = r.u16();
    if (!(this.width > 0 && this.height > 0 && this.width <= MAX_SIDE && this.height <= MAX_SIDE)) throw broken(L('странный размер холста', 'the canvas size is invalid'));
    if (this.mode !== RGB && this.mode !== GRAYSCALE) {
      const name = MODE_NAMES[this.mode] ?? String(this.mode);
      throw new Error(L(`Файл в режиме ${name}: переведите его в RGB в Фотошопе`, `The file is in ${name} mode: convert it to RGB in Photoshop`));
    }
    if (this.depth !== 8 && this.depth !== 16) throw new Error(L(`В файле ${this.depth} бит на канал: переведите его в 8 или 16 бит в Фотошопе`, `The file has ${this.depth} bits per channel: convert it to 8 or 16 bits in Photoshop`));
    r.skip(r.u32());
    const resources = this.parseResources();
    this.density = resources.density;
    this.profile = resources.profile;
    const { records, mergedAt } = this.parseLayerSection();
    this.records = records;
    this.mergedAt = mergedAt;
    this.background = this.findBackground();
  }

  static open(path: string): PsdFile {
    const fd = openSync(path, 'r');
    try {
      return new PsdFile(fd);
    } catch (err) {
      closeSync(fd);
      throw err;
    }
  }

  close(): void {
    closeSync(this.fd);
  }

  private parseResources(): { density?: number; profile?: string } {
    const r = this.reader;
    const length = r.u32();
    const end = r.pos + length;
    const found: { density?: number; profile?: string } = {};
    while (end - r.pos >= 12 && r.text(4) === '8BIM') {
      const id = r.u16();
      const nameLength = r.u8();
      r.skip(nameLength + ((nameLength + 1) % 2));
      const size = r.u32();
      const data = r.pos;
      if (id === 1005 && size >= 16) {
        const dpi = r.u32() / 65536;
        if (r.u16() === 1 && dpi > 0) found.density = dpi;
      } else if (id === 1039 && size >= 132 && size < 1 << 24) {
        const icc = r.block(data, size);
        found.profile = iccDescription(icc);
      }
      r.pos = data + size + (size % 2);
    }
    r.pos = end;
    return found;
  }

  private parseLayerSection(): { records: PsdRecord[]; mergedAt: number } {
    const r = this.reader;
    const length = r.length(this.psb);
    const end = r.pos + length;
    let records: PsdRecord[] = [];
    if (length) {
      const infoLength = r.length(this.psb);
      let infoEnd = r.pos + infoLength;
      if (infoLength) records = parseLayers(r, this.psb);
      if (infoEnd % 2) infoEnd++;
      r.pos = infoEnd;
      if (end - r.pos >= 4) {
        const global = r.u32();
        r.skip(global);
      }
      // В 16-битном файле слои лежат в блоке Lr16 в конце секции
      while (end - r.pos >= 12) {
        const signature = r.text(4);
        if (signature !== '8BIM' && signature !== '8B64') {
          r.pos -= 3;
          continue;
        }
        const key = r.text(4);
        const size = signature === '8B64' || (this.psb && LARGE_KEYS.has(key)) ? r.u64() : r.u32();
        const data = r.pos;
        if (!records.length && (key === 'Lr16' || key === 'Lr32' || key === 'Layr')) records = parseLayers(r, this.psb);
        r.pos = data + size;
      }
    }
    return { records, mergedAt: end };
  }

  private findBackground(): PsdRecord | null {
    const r = this.records[0];
    if (!r || r.kind !== 'pixels' || r.parent !== null || r.hidden || r.clipping || r.opacity !== 255 || r.fill !== 255) return null;
    if (r.blend !== 'norm' || r.channels.some((c) => c.id < 0)) return null;
    return r.left <= 0 && r.top <= 0 && r.right >= this.width && r.bottom >= this.height ? r : null;
  }

  private imports(r: PsdRecord): boolean {
    return (r.kind === 'pixels' || r.kind === 'smart') && r !== this.background && intersect(r, this.width, this.height) !== null;
  }

  private ancestors(r: PsdRecord): PsdRecord[] {
    const out: PsdRecord[] = [];
    for (let p = r.parent, i = 0; p !== null && i < 256; i++) {
      const g = this.records[p]!;
      out.push(g);
      p = g.parent;
    }
    return out;
  }

  private isHidden(r: PsdRecord): boolean {
    return r.hidden || this.ancestors(r).some((g) => g.hidden);
  }

  summary(): PsdSummary {
    const canvas = this.width * this.height;
    // Исходник, холст и его уменьшенные копии
    const base = canvas * 7;
    const s: PsdSummary = {
      width: this.width,
      height: this.height,
      density: this.density,
      profile: this.profile && !/srgb/i.test(this.profile) ? this.profile : undefined,
      layers: 0,
      hidden: 0,
      bytes: base,
      visibleBytes: base,
      text: 0,
      vector: 0,
      adjustment: 0,
      blend: 0,
    };
    for (const r of this.records) {
      if (r.kind === 'text') s.text++;
      else if (r.kind === 'vector') s.vector++;
      else if (r.kind === 'adjustment') s.adjustment++;
      if (r.kind === 'group' && !EXACT.has(r.blend)) s.blend++;
      if (!this.imports(r)) continue;
      const rect = intersect(r, this.width, this.height)!;
      // Пиксели, маска версии и маска слоя
      const bytes = rect.width * rect.height * 6;
      s.layers++;
      s.bytes += bytes;
      if (this.isHidden(r)) s.hidden++;
      else s.visibleBytes += bytes;
      if (!EXACT.has(r.blend)) s.blend++;
    }
    return s;
  }

  groups(): PsdGroup[] {
    return this.records.flatMap((r, id) => (r.kind === 'group' ? [{ id, name: r.name, hidden: r.hidden, parent: r.parent }] : []));
  }

  private plane(ch: Channel, width: number, height: number): Uint8Array {
    if (ch.length < 2 || width <= 0 || height <= 0) return new Uint8Array(Math.max(width, 0) * Math.max(height, 0));
    const data = this.reader.block(ch.offset, ch.length);
    const compression = data.readUInt16BE(0);
    const rowBytes = (width * this.depth) >> 3;
    const size = rowBytes * height;
    if (size > 2 ** 34) throw broken(L('странный размер слоя', 'a layer size is invalid'));
    let out: Uint8Array;
    if (compression === 0) {
      if (data.length - 2 < size) throw truncated();
      out = data.subarray(2, 2 + size);
    } else if (compression === 1) {
      const table = height * (this.psb ? 4 : 2);
      if (data.length < 2 + table) throw truncated();
      out = unpackRows(data, 2, height, this.psb, data, 2 + table, rowBytes);
    } else if (compression === 2 || compression === 3) {
      out = inflateSync(data.subarray(2), { maxOutputLength: size });
      if (out.length < size) throw truncated();
      if (compression === 3) unpredict(out, rowBytes, height, this.depth);
    } else {
      throw broken(L(`неизвестное сжатие ${compression}`, `unknown compression ${compression}`));
    }
    return to8Bit(out, this.depth);
  }

  private channel(r: PsdRecord, id: number): Uint8Array | null {
    const ch = r.channels.find((c) => c.id === id);
    return ch ? this.plane(ch, r.right - r.left, r.bottom - r.top) : null;
  }

  private loadMask(r: PsdRecord): LoadedMask | null {
    const m = r.mask;
    if (!m) return null;
    const real = r.channels.find((c) => c.id === -3);
    if (real && m.real && !m.real.disabled) {
      return { ...m.real, data: this.plane(real, m.real.right - m.real.left, m.real.bottom - m.real.top) };
    }
    const user = r.channels.find((c) => c.id === -2);
    if (!user || m.disabled || m.fromVector) return null;
    return { top: m.top, left: m.left, bottom: m.bottom, right: m.right, fill: m.fill, data: this.plane(user, m.right - m.left, m.bottom - m.top) };
  }

  /** Сколько от слоя непрозрачно: его прозрачность, маска, непрозрачность и то же от его групп */
  private coverage(r: PsdRecord, rect: Rect): Uint8Array {
    const lw = r.right - r.left;
    const alpha = new Uint8Array(rect.width * rect.height).fill(255);
    const plane = this.channel(r, -1);
    if (plane) {
      const dx = rect.x - r.left;
      const dy = rect.y - r.top;
      for (let y = 0; y < rect.height; y++) alpha.set(plane.subarray((y + dy) * lw + dx, (y + dy) * lw + dx + rect.width), y * rect.width);
    }
    let k = mul(r.opacity, r.fill);
    const mask = this.loadMask(r);
    if (mask) applyMask(alpha, rect, mask);
    for (const g of this.ancestors(r)) {
      k = mul(k, g.opacity);
      const id = this.records.indexOf(g);
      if (!this.groupMasks.has(id)) this.groupMasks.set(id, this.loadMask(g));
      const m = this.groupMasks.get(id);
      if (m) applyMask(alpha, rect, m);
    }
    if (k !== 255) for (let i = 0; i < alpha.length; i++) alpha[i] = mul(alpha[i]!, k);
    return alpha;
  }

  /** Плоскости цвета в цель: stride 3 — RGB исходника, 4 — RGBA слоя */
  private color(r: PsdRecord, rect: Rect, out: Uint8Array, stride: number): void {
    const lw = r.right - r.left;
    const dx = rect.x - r.left;
    const dy = rect.y - r.top;
    const gray = this.mode === GRAYSCALE;
    for (let c = 0; c < (gray ? 1 : 3); c++) {
      const plane = this.channel(r, c);
      if (!plane) continue;
      for (let y = 0; y < rect.height; y++) {
        const from = (y + dy) * lw + dx;
        let to = y * rect.width * stride + c;
        for (let x = 0; x < rect.width; x++, to += stride) {
          const v = plane[from + x]!;
          out[to] = v;
          if (gray) {
            out[to + 1] = v;
            out[to + 2] = v;
          }
        }
      }
    }
  }

  /** Исходник документа, RGB: фон из файла; без слоёв-картинок — готовая картинка файла; иначе белый */
  readBase(): Uint8Array {
    const out = new Uint8Array(this.width * this.height * 3);
    const bg = this.background;
    if (bg) {
      this.color(bg, { x: 0, y: 0, width: this.width, height: this.height }, out, 3);
      return out;
    }
    if (this.records.some((r) => this.imports(r))) return out.fill(255);
    this.readMerged(out);
    return out;
  }

  private readMerged(out: Uint8Array): void {
    const r = this.reader;
    r.pos = this.mergedAt;
    const compression = r.u16();
    const rowBytes = (this.width * this.depth) >> 3;
    const planes = this.mode === RGB ? 3 : 1;
    const put = (data: Uint8Array, c: number) => {
      const eight = to8Bit(data, this.depth);
      for (let i = 0; i < eight.length; i++) {
        out[i * 3 + c] = eight[i]!;
        if (planes === 1) {
          out[i * 3 + 1] = eight[i]!;
          out[i * 3 + 2] = eight[i]!;
        }
      }
    };
    if (compression === 0) {
      for (let c = 0; c < planes; c++) put(r.block(this.mergedAt + 2 + c * rowBytes * this.height, rowBytes * this.height), c);
      return;
    }
    if (compression !== 1) throw broken(L(`неизвестное сжатие ${compression}`, `unknown compression ${compression}`));
    const entry = this.psb ? 4 : 2;
    const tableSize = this.height * this.channels * entry;
    const table = r.block(r.pos, tableSize);
    let offset = r.pos + tableSize;
    for (let c = 0; c < planes; c++) {
      let bytes = 0;
      for (let row = 0; row < this.height; row++) {
        const at = (c * this.height + row) * entry;
        bytes += this.psb ? table.readUInt32BE(at) : table.readUInt16BE(at);
      }
      put(unpackRows(table, c * this.height * entry, this.height, this.psb, r.block(offset, bytes), 0, rowBytes), c);
      offset += bytes;
    }
  }

  /** Слои снизу вверх, по одному. skipHidden — без скрытых (сами или группой) */
  *layers(opts: { skipHidden?: boolean } = {}): Generator<PsdLayer> {
    let clip: { rect: Rect; alpha: Uint8Array; hidden: boolean } | null = null;
    for (let i = 0; i < this.records.length; i++) {
      const r = this.records[i]!;
      if (!r.clipping) clip = null;
      const rect = intersect(r, this.width, this.height);
      const clipsNext = this.records[i + 1]?.clipping === true;
      // Текст не берём, но обтравленное им — по его форме
      if (r.kind === 'text' && clipsNext) clip = { rect: rect ?? NOWHERE, alpha: rect ? this.coverage(r, rect) : new Uint8Array(0), hidden: r.hidden };
      if (!rect || !this.imports(r)) {
        if (!rect && (r.kind === 'pixels' || r.kind === 'smart') && clipsNext) clip = { rect: NOWHERE, alpha: new Uint8Array(0), hidden: r.hidden };
        continue;
      }
      // Основы обтравки нет (вектор): без неё слой разлился бы по холсту — он приходит скрытым
      const hidden = r.hidden || (r.clipping && (!clip || clip.hidden));
      if (opts.skipHidden && (hidden || this.ancestors(r).some((g) => g.hidden))) {
        if (clipsNext && !r.clipping) clip = { rect: NOWHERE, alpha: new Uint8Array(0), hidden: true };
        continue;
      }
      const alpha = this.coverage(r, rect);
      if (clipsNext && !r.clipping) clip = { rect, alpha: alpha.slice(), hidden: r.hidden };
      if (r.clipping && clip) applyClip(alpha, rect, clip);
      const rgba = new Uint8Array(rect.width * rect.height * 4);
      this.color(r, rect, rgba, 4);
      for (let p = 0; p < alpha.length; p++) rgba[p * 4 + 3] = alpha[p]!;
      if (DARKENING.has(r.blend) || this.ancestors(r).some((g) => DARKENING.has(g.blend))) whiteToAlpha(rgba, alpha);
      const layer = finish(r.name, rect, rgba, alpha, hidden, r.parent);
      if (layer) yield layer;
    }
  }
}

const NOWHERE: Rect = { x: 0, y: 0, width: 0, height: 0 };

function applyMask(alpha: Uint8Array, rect: Rect, mask: LoadedMask): void {
  const mw = mask.right - mask.left;
  const mh = mask.bottom - mask.top;
  for (let y = 0, i = 0; y < rect.height; y++) {
    const my = rect.y + y - mask.top;
    const inRow = my >= 0 && my < mh;
    for (let x = 0; x < rect.width; x++, i++) {
      const mx = rect.x + x - mask.left;
      const v = inRow && mx >= 0 && mx < mw ? mask.data[my * mw + mx]! : mask.fill;
      if (v !== 255) alpha[i] = mul(alpha[i]!, v);
    }
  }
}

function applyClip(alpha: Uint8Array, rect: Rect, clip: { rect: Rect; alpha: Uint8Array }): void {
  for (let y = 0, i = 0; y < rect.height; y++) {
    const cy = rect.y + y - clip.rect.y;
    const inRow = cy >= 0 && cy < clip.rect.height;
    for (let x = 0; x < rect.width; x++, i++) {
      const cx = rect.x + x - clip.rect.x;
      alpha[i] = inRow && cx >= 0 && cx < clip.rect.width ? mul(alpha[i]!, clip.alpha[cy * clip.rect.width + cx]!) : 0;
    }
  }
}

/** Белое — прозрачно, чёрное — как было: для чёрно-белого точно на любом фоне, для цветного — точно на белом */
function whiteToAlpha(rgba: Uint8Array, alpha: Uint8Array): void {
  for (let p = 0; p < alpha.length; p++) {
    const r = rgba[p * 4]!;
    const g = rgba[p * 4 + 1]!;
    const b = rgba[p * 4 + 2]!;
    const m = Math.min(r, g, b);
    const room = 255 - m;
    if (room === 0) {
      alpha[p] = 0;
      rgba[p * 4 + 3] = 0;
      continue;
    }
    rgba[p * 4] = Math.round(((r - m) * 255) / room);
    rgba[p * 4 + 1] = Math.round(((g - m) * 255) / room);
    rgba[p * 4 + 2] = Math.round(((b - m) * 255) / room);
    alpha[p] = mul(alpha[p]!, room);
    rgba[p * 4 + 3] = alpha[p]!;
  }
}

function cropRect(values: Uint8Array, rect: Rect, test: (v: number) => boolean): Rect | null {
  let x0 = rect.width;
  let y0 = rect.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0, i = 0; y < rect.height; y++) {
    for (let x = 0; x < rect.width; x++, i++) {
      if (!test(values[i]!)) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      y1 = y;
    }
  }
  return x1 < 0 ? null : { x: rect.x + x0, y: rect.y + y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

function crop(data: Uint8Array, rect: Rect, inner: Rect, stride: number): Uint8Array {
  if (inner.width === rect.width && inner.height === rect.height) return data;
  const out = new Uint8Array(inner.width * inner.height * stride);
  for (let y = 0; y < inner.height; y++) {
    const from = ((inner.y - rect.y + y) * rect.width + inner.x - rect.x) * stride;
    out.set(data.subarray(from, from + inner.width * stride), y * inner.width * stride);
  }
  return out;
}

/** Обрезка по непрозрачному и область слоя: у бледного слоя порог — от его самого плотного места */
function finish(name: string, rect: Rect, rgba: Uint8Array, alpha: Uint8Array, hidden: boolean, group: number | null): PsdLayer | null {
  const inner = cropRect(alpha, rect, (v) => v > 0);
  if (!inner) return null;
  const cropped = crop(alpha, rect, inner, 1);
  let max = 0;
  for (const v of cropped) if (v > max) max = v;
  const threshold = Math.max(1, Math.ceil(max / 2));
  const shape = cropRect(cropped, inner, (v) => v >= threshold)!;
  const part = crop(cropped, inner, shape, 1);
  const mask = new Uint8Array(part.length);
  for (let i = 0; i < part.length; i++) mask[i] = part[i]! >= threshold ? 255 : 0;
  return {
    name: name || L('Слой', 'Layer'),
    rect: inner,
    rgba: crop(rgba, rect, inner, 4),
    alpha: cropped,
    object: { rect: shape, mask },
    hidden,
    group,
  };
}
