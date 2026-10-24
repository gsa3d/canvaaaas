import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { buildPrompt, prepareEdit } from '../src/core/edit-region.ts';
import { renderMask } from '../src/core/mask-shapes.ts';
import { mockProvider } from '../src/providers/mock.ts';

describe('промпт и референсы', () => {
  it('задача идёт первой, референсы нумеруются после куска, стиль — в конце', () => {
    const text = buildPrompt('pair', 'соедини рельсы', { style: 'книжная иллюстрация', references: 2 });
    expect(text.indexOf('TASK: соедини рельсы')).toBeLessThan(text.indexOf('Image 1'));
    expect(text).toContain('Images 3–4 are reference images');
    expect(text.trim().endsWith('Style of the whole illustration: книжная иллюстрация')).toBe(true);
    expect(buildPrompt('overlay', 'x', { references: 1 })).toContain('Image 2 is a reference image');
    expect(buildPrompt('pair', 'x')).not.toContain('reference');
  });

  it('референсы уходят модели после чистого куска и куска с подсветкой', async () => {
    const image = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#888' } }).png().toBuffer();
    const mask = await renderMask(800, 600, [{ kind: 'rect', x: 300, y: 200, width: 200, height: 150 }]);
    const ref = { data: await sharp({ create: { width: 64, height: 64, channels: 3, background: '#f00' } }).jpeg().toBuffer(), mimeType: 'image/jpeg' };
    const prep = await prepareEdit({ image, mask, prompt: 'x', provider: mockProvider(), references: [ref, ref] });
    expect(prep.images).toHaveLength(4);
    expect(prep.images[2]).toBe(ref);
    expect(prep.prompt).toContain('Images 3–4');
  });
});
