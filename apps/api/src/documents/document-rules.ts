import { maxBytesFor } from '../media/media-rules.js';
import { CSV_MIME, MAX_CSV_BYTES } from './documents.dto.js';

/** The largest file accepted for a document type (bank files 5 MB; PDFs and images as media). */
export function documentMaxBytes(mime: string): number {
  return mime === CSV_MIME ? MAX_CSV_BYTES : maxBytesFor(mime);
}

/**
 * A bank file is accepted as text/csv only if it is UTF-8 text with no control
 * characters other than tab and line breaks (there are no magic bytes to sniff).
 */
export function isPlainText(content: Buffer): boolean {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    return false;
  }
   
  return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text);
}
