import type { RasterFormat } from './image-runtime.js';

// Cheap structural walk for processors whose decoder warnings are not visible
// (the Cloudflare Images binding): the file must be one complete static
// container with bounded header dimensions. It checks framing only, not that
// compressed data is complete or decodable; the binding must still decode it.
export interface RasterHeader { readonly width: number; readonly height: number }

const ascii = (bytes: Uint8Array, start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
const fail = (why: string): never => { throw new Error(`incomplete ${why}`); };

function png(bytes: Uint8Array, view: DataView): RasterHeader {
  if (bytes.length < 8 + 25 + 12 || view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a || view.getUint32(8) !== 13 || ascii(bytes, 12, 16) !== 'IHDR') fail('PNG header');
  for (let offset = 8; ;) {
    if (offset + 12 > bytes.length) fail('PNG chunk');
    const length = view.getUint32(offset), type = ascii(bytes, offset + 4, offset + 8);
    if (length > bytes.length - offset - 12 || type === 'acTL' || type === 'fcTL' || type === 'fdAT') fail('PNG chunk');
    offset += length + 12;
    // IEND must be the last bytes (structural framing only; IDAT contents are
    // not inflated here, so the binding must still decode them).
    if (type === 'IEND') { if (length || offset !== bytes.length) fail('PNG end'); break; }
  }
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function jpeg(bytes: Uint8Array, view: DataView): RasterHeader {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) fail('JPEG markers');
  let header: RasterHeader | null = null;
  for (let offset = 2; ;) {
    if (bytes[offset] !== 0xff) fail('JPEG segment');
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0xd9 || marker === 0xd8) fail('JPEG segment');
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) fail('JPEG segment');
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > bytes.length) fail('JPEG segment');
    // SOF0-15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (header || length < 8) fail('JPEG frame');
      header = { width: view.getUint16(offset + 5), height: view.getUint16(offset + 3) };
    }
    if (marker === 0xda) { if (!header) fail('JPEG frame'); return header!; }
    offset += length;
  }
}

function webp(bytes: Uint8Array, view: DataView): RasterHeader {
  if (bytes.length < 20 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 12) !== 'WEBP' || view.getUint32(4, true) + 8 !== bytes.length) fail('WebP container');
  let canvas: RasterHeader | null = null, header: RasterHeader | null = null, bitstreams = 0;
  for (let offset = 12; offset < bytes.length;) {
    if (offset + 8 > bytes.length) fail('WebP chunk');
    const type = ascii(bytes, offset, offset + 4), length = view.getUint32(offset + 4, true), data = offset + 8;
    if (length > bytes.length - data - (length & 1)) fail('WebP chunk');
    if (type === 'ANIM' || type === 'ANMF' || (type === 'VP8X' && (length < 10 || (bytes[data] & 0x02)))) fail('static WebP');
    if (type === 'VP8X' && offset === 12) canvas = { width: 1 + (bytes[data + 4] | bytes[data + 5] << 8 | bytes[data + 6] << 16), height: 1 + (bytes[data + 7] | bytes[data + 8] << 8 | bytes[data + 9] << 16) };
    if (type === 'VP8 ') {
      if (length < 10 || bytes[data + 3] !== 0x9d || bytes[data + 4] !== 0x01 || bytes[data + 5] !== 0x2a) fail('VP8 frame');
      header = { width: view.getUint16(data + 6, true) & 0x3fff, height: view.getUint16(data + 8, true) & 0x3fff };
      bitstreams++;
    } else if (type === 'VP8L') {
      if (length < 5 || bytes[data] !== 0x2f) fail('VP8L frame');
      const bits = view.getUint32(data + 1, true);
      header = { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
      bitstreams++;
    }
    offset = data + length + (length & 1);
  }
  if (bitstreams !== 1 || !header) fail('WebP bitstream');
  // The coded frame is what gets decoded and bounded; a VP8X canvas must match it.
  if (canvas && (canvas.width !== header!.width || canvas.height !== header!.height)) fail('WebP canvas');
  return header!;
}

// Throws unless `bytes` is a complete static `format` file within the bounds.
export function assertCompleteRaster(bytes: Uint8Array, format: RasterFormat, maxDimension: number, maxPixels: number): RasterHeader {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = format === 'png' ? png(bytes, view) : format === 'jpeg' ? jpeg(bytes, view) : webp(bytes, view);
  const { width, height } = header;
  if (!(width >= 1 && height >= 1 && width <= maxDimension && height <= maxDimension && width * height <= maxPixels)) throw new Error('image dimensions out of bounds');
  return header;
}
