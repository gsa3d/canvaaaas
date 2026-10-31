import { describe, expect, it } from 'vitest';
import { changeEdge, lineMap, snapToLines } from '../src/core/lines.ts';
import { area } from '../src/core/objects.ts';

const W = 200;
const rect = { x: 0, y: 0, width: W, height: W };

/** Белый лист, квадрат 50..150 обведён линией в 4 px, в правой стороне щель в 2 px, внутри — штрих поперёк */
function drawing(): Buffer {
  const rgb = Buffer.alloc(W * W * 3, 255);
  const ink = (x: number, y: number) => rgb.fill(0, (y * W + x) * 3, (y * W + x) * 3 + 3);
  for (let y = 50; y < 150; y++) {
    for (let x = 50; x < 150; x++) {
      const edge = x < 54 || x >= 146 || y < 54 || y >= 146;
      const gap = x >= 146 && y >= 99 && y < 101;
      if (edge && !gap) ink(x, y);
    }
  }
  for (let x = 54; x < 146; x++) ink(x, 100);
  return rgb;
}

const at = (b: { rect: typeof rect; mask: Uint8Array } | null, x: number, y: number) =>
  !!b && x >= b.rect.x && y >= b.rect.y && x < b.rect.x + b.rect.width && y < b.rect.y + b.rect.height && b.mask[(y - b.rect.y) * b.rect.width + x - b.rect.x]! > 0;

describe('Линии рисунка', () => {
  it('привязка: маска «на глаз» ложится по линиям — клетка целиком, с контуром, без соседа снаружи', () => {
    const rgb = drawing();
    const map = lineMap(rgb, rect);
    // Грубая маска верхней половины: не доходит до линий и чуть вылезает за правую
    const rough = { rect: { x: 60, y: 58, width: 100, height: 36 }, mask: new Uint8Array(100 * 36).fill(255) };
    const snapped = snapToLines(rough, map)!;
    expect(at(snapped, 56, 56)).toBe(true);
    expect(at(snapped, 51, 70)).toBe(true);
    expect(at(snapped, 100, 120)).toBe(false);
    // Вылезшее наружу едва задевает огромную внешнюю область — выброшено
    expect(at(snapped, 157, 70)).toBe(false);
    // Мазок кистью по верхней половине захватывает её целиком
    const stroke = { rect: { x: 90, y: 70, width: 20, height: 10 }, mask: new Uint8Array(200).fill(255) };
    const brushed = snapToLines(stroke, map, 30)!;
    expect(at(brushed, 60, 60)).toBe(true);
    expect(at(brushed, 100, 120)).toBe(false);
  });

  it('привязка: сплошь тёмное под маской (кудри) остаётся целиком, задетый штрих за светлым — нет', () => {
    const rgb = drawing();
    const ink = (x: number, y: number) => rgb.fill(0, (y * W + x) * 3, (y * W + x) * 3 + 3);
    // Кудри справа от квадрата: тёмная масса в мелких светлых точках; правее, за белым, — чужой штрих
    for (let y = 60; y < 140; y++) for (let x = 146; x < 186; x++) if (x % 4 || y % 4) ink(x, y);
    for (let y = 70; y < 80; y++) for (let x = 196; x < 199; x++) ink(x, y);
    const map = lineMap(rgb, rect);
    const rough = { rect: { x: 60, y: 58, width: 140, height: 36 }, mask: new Uint8Array(140 * 36).fill(255) };
    const snapped = snapToLines(rough, map)!;
    expect(at(snapped, 60, 60)).toBe(true);
    // Далеко от светлой клетки, но под маской и вплотную к взятому
    expect(at(snapped, 178, 80)).toBe(true);
    expect(at(snapped, 178, 130)).toBe(false);
    expect(at(snapped, 197, 75)).toBe(false);
  });

  it('край шире и уже', () => {
    const square = { rect: { x: 50, y: 50, width: 20, height: 20 }, mask: new Uint8Array(400).fill(255) };
    const wider = changeEdge(square, 3, rect)!;
    expect(wider.rect).toEqual({ x: 47, y: 47, width: 26, height: 26 });
    const narrower = changeEdge(square, -3, rect)!;
    expect(narrower.rect).toEqual({ x: 53, y: 53, width: 14, height: 14 });
    expect(area(narrower)).toBe(14 * 14);
    expect(changeEdge(square, -10, rect)).toBeNull();
  });
});
