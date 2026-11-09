// Цветовой профиль: без sharp, потому что нужен и потоку чтения PSD

/** Название ICC-профиля из тега desc: «sRGB IEC61966-2.1», «Display P3»…; пустая строка, если не прочитать */
export function iccDescription(icc: Buffer): string {
  try {
    const count = icc.readUInt32BE(128);
    for (let i = 0; i < count; i++) {
      const entry = 132 + i * 12;
      if (icc.toString('latin1', entry, entry + 4) !== 'desc') continue;
      const tag = icc.readUInt32BE(entry + 4);
      const type = icc.toString('latin1', tag, tag + 4);
      if (type === 'desc') {
        const length = icc.readUInt32BE(tag + 8);
        return icc.toString('latin1', tag + 12, tag + 12 + length).replace(/\0+$/, '').trim();
      }
      if (type === 'mluc') {
        // ICC v4: первая запись списка строк, UTF-16BE
        const length = icc.readUInt32BE(tag + 20);
        const start = tag + icc.readUInt32BE(tag + 24);
        return Buffer.from(icc.subarray(start, start + length - (length % 2)))
          .swap16()
          .toString('utf16le')
          .replace(/\0+$/, '')
          .trim();
      }
    }
  } catch {
    // битый профиль — описание неизвестно
  }
  return '';
}
