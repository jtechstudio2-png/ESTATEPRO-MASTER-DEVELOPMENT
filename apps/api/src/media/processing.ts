import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { constants as zlibConstants, inflateSync } from 'node:zlib';

import { fileTypeFromBuffer } from 'file-type';
import sharp, { type Metadata } from 'sharp';

import {
  MASTER_MAX_SIDE,
  MAX_IMAGE_PIXELS,
  MAX_IMAGE_SIDE,
  MAX_PDF_PAGES,
  MIN_PLAN_SIDE,
  PDF_MIME,
  VARIANTS,
  type VariantName,
} from './media-rules.js';

const run = promisify(execFile);

/** A content problem: the file is rejected and not retried. */
export class ContentRejected extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ImageOutput {
  buffer: Buffer;
  contentType: string;
  width: number;
  height: number;
}

export interface ProcessedMedia {
  /** Kept privately for reprocessing: re-encoded image, or the validated PDF. */
  master: ImageOutput & { extension: 'jpg' | 'png' | 'pdf' };
  /** Display image dimensions (first page for PDFs). */
  width: number;
  height: number;
  pageCount: number | null;
  variants: Array<ImageOutput & { name: VariantName; hash: string }>;
}

/** The real content type from the file's bytes; never the client's claim. */
export async function sniffMime(buffer: Buffer): Promise<string | null> {
  return (await fileTypeFromBuffer(buffer))?.mime ?? null;
}

export function sha256(buffer: Buffer): Buffer {
  return createHash('sha256').update(buffer).digest();
}

/**
 * Decodes an image fully (with pixel limits), re-encodes a metadata-free sRGB
 * master and the display sizes. No uploaded bytes are ever served as-is, and
 * EXIF/IPTC/XMP (including GPS) never reach any output (M-D7).
 */
export async function processImage(input: Buffer, plan: boolean): Promise<ProcessedMedia> {
  let meta: Metadata;
  try {
    meta = await sharp(input, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: 'error' }).metadata();
  } catch (error) {
    throw toContentError(error);
  }
  const width = meta.autoOrient.width;
  const height = meta.autoOrient.height;
  if (Math.max(width, height) > MAX_IMAGE_SIDE) {
    throw new ContentRejected('too-large', `Images can be at most ${MAX_IMAGE_SIDE} pixels on a side.`);
  }
  if (plan && Math.max(width, height) < MIN_PLAN_SIDE) {
    throw new ContentRejected('too-small', `Plans must be at least ${MIN_PLAN_SIDE} pixels on the longest side to be readable.`);
  }

  let pixels: RawImage;
  try {
    // Decode once (auto-orient, sRGB, capped at the master size); every output is encoded from these pixels.
    let base = sharp(input, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: 'error' })
      .rotate()
      .resize({ width: MASTER_MAX_SIDE, height: MASTER_MAX_SIDE, fit: 'inside', withoutEnlargement: true })
      .toColourspace('srgb');
    if (!plan) base = base.flatten({ background: '#ffffff' });
    const decoded = await base.raw().toBuffer({ resolveWithObject: true });
    pixels = { data: decoded.data, width: decoded.info.width, height: decoded.info.height, channels: decoded.info.channels };
  } catch (error) {
    throw toContentError(error);
  }
  // libjpeg at quality 90: mozjpeg was ~15x slower for a few percent in size (M4 performance test).
  const encoded = plan
    ? await fromRaw(pixels).png({ compressionLevel: 6 }).toBuffer()
    : await fromRaw(pixels).jpeg({ quality: 90 }).toBuffer();
  const master: ProcessedMedia['master'] = {
    buffer: encoded,
    contentType: plan ? 'image/png' : 'image/jpeg',
    extension: plan ? 'png' : 'jpg',
    width: pixels.width,
    height: pixels.height,
  };
  return { master, width: master.width, height: master.height, pageCount: null, variants: await variantsOf(pixels, plan) };
}

interface RawImage {
  data: Buffer;
  width: number;
  height: number;
  channels: 1 | 2 | 3 | 4;
}

function fromRaw(image: RawImage) {
  return sharp(image.data, { raw: { width: image.width, height: image.height, channels: image.channels } });
}

/** WebP display sizes from already oriented, metadata-free pixels. */
export async function variantsOf(source: RawImage, plan: boolean): Promise<ProcessedMedia['variants']> {
  const variants: ProcessedMedia['variants'] = [];
  for (const { name, size } of VARIANTS) {
    const out = await fromRaw(source)
      .resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
      .webp(plan ? { lossless: true, effort: 2 } : { quality: 80, effort: 2 })
      .toBuffer({ resolveWithObject: true });
    variants.push({
      name,
      buffer: out.data,
      contentType: 'image/webp',
      width: out.info.width,
      height: out.info.height,
      hash: sha256(out.data).toString('hex').slice(0, 12),
    });
  }
  return variants;
}

// ----------------------------------------------------------------------------- PDF

const UNSAFE_PDF_NAMES = /\/(JavaScript|JS|Launch|EmbeddedFile|EmbeddedFiles|XFA|RichMedia|OpenAction|AA|SubmitForm|ImportData|GoToR)\b/;
const MAX_INFLATED_BYTES = 64 * 1024 * 1024;

/**
 * Structural and safety checks for PDFs: header, trailer, no encryption and
 * no active content (scripts, launch/submit actions, automatic actions,
 * embedded files, XFA, rich media), including inside compressed streams.
 */
export function inspectPdf(buffer: Buffer): void {
  if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') throw new ContentRejected('invalid-pdf', 'This is not a valid PDF file.');
  if (!buffer.subarray(Math.max(0, buffer.length - 2048)).toString('latin1').includes('%%EOF')) {
    throw new ContentRejected('invalid-pdf', 'This PDF file is incomplete.');
  }
  const text = buffer.toString('latin1');
  if (/\/Encrypt\b/.test(text)) throw new ContentRejected('encrypted-pdf', 'Password-protected PDFs are not accepted.');
  if (UNSAFE_PDF_NAMES.test(text)) throw new ContentRejected('unsafe-pdf', 'PDFs with scripts, actions or embedded files are not accepted.');

  let inflated = 0;
  // "stream" keyword at a stream start (not the tail of "endstream").
  const streams = /(?<!end)stream\r?\n/g;
  let match: RegExpExecArray | null;
  while ((match = streams.exec(text)) !== null) {
    const start = match.index + match[0].length;
    const end = text.indexOf('endstream', start);
    if (end < 0) break;
    streams.lastIndex = end + 'endstream'.length;
    const dictionary = text.slice(Math.max(0, match.index - 512), match.index);
    if (!/\/FlateDecode/.test(dictionary)) continue;
    // Data ends before the end-of-line that precedes "endstream".
    let dataEnd = end;
    if (buffer[dataEnd - 1] === 0x0a) dataEnd -= 1;
    if (buffer[dataEnd - 1] === 0x0d) dataEnd -= 1;
    let decoded: Buffer;
    try {
      // Sync flush decodes what it can from damaged or truncated streams too.
      decoded = inflateSync(buffer.subarray(start, dataEnd), { finishFlush: zlibConstants.Z_SYNC_FLUSH, maxOutputLength: MAX_INFLATED_BYTES - inflated });
    } catch {
      throw new ContentRejected('invalid-pdf', 'This PDF contains damaged or oversized compressed data.');
    }
    inflated += decoded.length;
    if (UNSAFE_PDF_NAMES.test(decoded.toString('latin1'))) {
      throw new ContentRejected('unsafe-pdf', 'PDFs with scripts, actions or embedded files are not accepted.');
    }
  }
}

/**
 * Renders the first page with Poppler in a separate, time-limited process and
 * builds the preview sizes. The PDF itself is the master (downloaded only).
 */
export async function processPdf(buffer: Buffer, options: { timeoutMs?: number } = {}): Promise<ProcessedMedia> {
  inspectPdf(buffer);
  const timeout = options.timeoutMs ?? 60_000;
  const dir = await mkdtemp(join(tmpdir(), 'estatepro-pdf-'));
  try {
    const input = join(dir, 'input.pdf');
    await writeFile(input, buffer);
    let pages: number;
    try {
      const info = await run('pdfinfo', [input], { timeout, maxBuffer: 1024 * 1024 });
      pages = Number(/^Pages:\s+(\d+)/m.exec(info.stdout)?.[1] ?? NaN);
    } catch {
      throw new ContentRejected('invalid-pdf', 'This PDF file could not be read.');
    }
    if (!Number.isInteger(pages) || pages < 1) throw new ContentRejected('invalid-pdf', 'This PDF file has no pages.');
    if (pages > MAX_PDF_PAGES) throw new ContentRejected('too-many-pages', `PDFs can have at most ${MAX_PDF_PAGES} pages.`);

    try {
      await run('pdftoppm', ['-f', '1', '-l', '1', '-r', '150', '-scale-to', String(MASTER_MAX_SIDE), '-png', '-singlefile', input, join(dir, 'page')], {
        timeout,
        maxBuffer: 1024 * 1024,
      });
    } catch {
      throw new ContentRejected('invalid-pdf', 'The first page of this PDF could not be rendered.');
    }
    const page = await readFile(join(dir, 'page.png'));
    const preview = await sharp(page, { limitInputPixels: MAX_IMAGE_PIXELS }).toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
    const pixels: RawImage = { data: preview.data, width: preview.info.width, height: preview.info.height, channels: preview.info.channels };
    return {
      master: { buffer, contentType: PDF_MIME, extension: 'pdf', width: pixels.width, height: pixels.height },
      width: pixels.width,
      height: pixels.height,
      pageCount: pages,
      variants: await variantsOf(pixels, true),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function toContentError(error: unknown): ContentRejected {
  if (error instanceof ContentRejected) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/pixel limit/i.test(message)) {
    return new ContentRejected('too-large', `Images can have at most ${MAX_IMAGE_PIXELS / 1_000_000} megapixels.`);
  }
  return new ContentRejected('invalid-image', 'This image could not be read. It may be damaged or in an unsupported format.');
}
