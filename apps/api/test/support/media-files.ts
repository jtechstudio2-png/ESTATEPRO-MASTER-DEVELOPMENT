import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';

import sharp from 'sharp';

/** Test files for the media pipeline, built deterministically in code. */

export const EICAR = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*', 'latin1');

export function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/** A JPEG photo with EXIF, including GPS coordinates, and a rotation flag. */
export function photoWithGps(width = 3000, height = 2000): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: '#7a9cc6' } })
    .composite([{ input: { create: { width: Math.floor(width / 3), height: Math.floor(height / 3), channels: 3, background: '#c67a7a' } }, top: 10, left: 10 }])
    .jpeg({ quality: 85 })
    .withExif({
      IFD0: { Copyright: 'Test photographer' },
      IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '5/1 33/1 25/1', GPSLongitudeRef: 'W', GPSLongitude: '0/1 11/1 2/1' },
    })
    .withMetadata({ orientation: 6 })
    .toBuffer();
}

export function png(width: number, height: number, colour = '#ffffff'): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: colour } })
    .composite([{ input: { create: { width: Math.max(1, Math.floor(width / 2)), height: 4, channels: 3, background: '#000000' } }, top: Math.floor(height / 2), left: 10 }])
    .png()
    .toBuffer();
}

export function webp(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: '#33aa66' } }).webp().toBuffer();
}

/** A PNG whose header claims 30,000 × 30,000 pixels (a decompression bomb). */
export function pngBomb(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(30_000, 0);
  header.writeUInt32BE(30_000, 4);
  header.writeUInt8(8, 8); // bit depth
  header.writeUInt8(2, 9); // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc(1024))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** JPEG magic bytes followed by garbage. */
export function corruptJpeg(): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]), Buffer.alloc(4096, 0x5a)]);
}

/**
 * A one-page PDF (1200 × 900 pt) drawn with a rectangle. Options add unsafe
 * constructs: catalog entries, a trailer entry, or a compressed stream with
 * hidden content.
 */
export function pdf(options: { catalogExtra?: string; trailerExtra?: string; hiddenInStream?: string; pages?: number } = {}): Buffer {
  const pageCount = options.pages ?? 1;
  const objects: Buffer[] = [];
  const pageIds = Array.from({ length: pageCount }, (_, index) => 4 + index * 2);
  objects.push(Buffer.from(`<< /Type /Catalog /Pages 2 0 R ${options.catalogExtra ?? ''} >>`, 'latin1'));
  objects.push(Buffer.from(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageCount} >>`, 'latin1'));
  objects.push(Buffer.from('<< /Producer (EstatePro tests) >>', 'latin1'));
  for (let page = 0; page < pageCount; page += 1) {
    const contentId = pageIds[page]! + 1;
    objects.push(Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1200 900] /Contents ${contentId} 0 R >>`, 'latin1'));
    const drawing = Buffer.from('0.2 0.4 0.8 rg 100 100 600 400 re f 0 0 0 RG 4 w 50 50 1100 800 re S', 'latin1');
    objects.push(Buffer.concat([Buffer.from(`<< /Length ${drawing.length} >>\nstream\n`, 'latin1'), drawing, Buffer.from('\nendstream', 'latin1')]));
  }
  if (options.hiddenInStream) {
    const packed = deflateSync(Buffer.from(options.hiddenInStream, 'latin1'));
    objects.push(Buffer.concat([Buffer.from(`<< /Length ${packed.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'), packed, Buffer.from('\nendstream', 'latin1')]));
  }

  const parts: Buffer[] = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets: number[] = [];
  let length = parts[0]!.length;
  objects.forEach((body, index) => {
    offsets.push(length);
    const object = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`, 'latin1'), body, Buffer.from('\nendobj\n', 'latin1')]);
    parts.push(object);
    length += object.length;
  });
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)].join('');
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 3 0 R ${options.trailerExtra ?? ''} >>\nstartxref\n${length}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}
