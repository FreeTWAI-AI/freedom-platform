// Container walk for processor output, not a decoder: stored avatars/covers
// must be one static RIFF/WebP bitstream at the target size with no metadata.
export interface WebpShape { readonly width: number; readonly height: number; readonly chunks: readonly string[] }

const ascii = (bytes: Uint8Array, start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));

export function inspectCanonicalWebp(bytes: Uint8Array): WebpShape {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), fail = (why: string): never => { throw new Error(`non-canonical WebP: ${why}`); };
  if (bytes.length < 20 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 12) !== 'WEBP' || view.getUint32(4, true) + 8 !== bytes.length) fail('container');
  const chunks: string[] = [];
  let width = 0, height = 0, canvas: { width: number; height: number } | null = null;
  for (let offset = 12; offset < bytes.length;) {
    if (offset + 8 > bytes.length) fail('chunk header');
    const type = ascii(bytes, offset, offset + 4), length = view.getUint32(offset + 4, true), data = offset + 8;
    if (length > bytes.length - data - (length & 1)) fail('chunk bounds');
    chunks.push(type);
    if (type === 'VP8X') {
      // Only the alpha flag is allowed: ICC, EXIF, XMP and animation flags are refused.
      if (offset !== 12 || length !== 10 || (bytes[data] & ~0x10) || bytes[data + 1] || bytes[data + 2] || bytes[data + 3]) fail('VP8X');
      canvas = { width: 1 + (bytes[data + 4] | bytes[data + 5] << 8 | bytes[data + 6] << 16), height: 1 + (bytes[data + 7] | bytes[data + 8] << 8 | bytes[data + 9] << 16) };
    } else if (type === 'ALPH') {
      // One alpha chunk, inside an extended file whose alpha flag is set, before the bitstream.
      if (!canvas || !(bytes[20] & 0x10) || width || chunks.indexOf('ALPH') !== chunks.length - 1) fail('ALPH');
    } else if (type === 'VP8 ') {
      // Key frame, start code, and no upscaling bits in the 14-bit dimensions.
      if (width || length < 10 || (bytes[data] & 1) || bytes[data + 3] !== 0x9d || bytes[data + 4] !== 0x01 || bytes[data + 5] !== 0x2a
        || (bytes[data + 7] & 0xc0) || (bytes[data + 9] & 0xc0)) fail('VP8');
      width = view.getUint16(data + 6, true); height = view.getUint16(data + 8, true);
    } else if (type === 'VP8L') {
      if (width || length < 5 || bytes[data] !== 0x2f || chunks.includes('ALPH') || (bytes[data + 4] >> 5)) fail('VP8L');
      const bits = view.getUint32(data + 1, true);
      width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1;
    } else fail(`chunk ${JSON.stringify(type)}`); // ICCP, EXIF, XMP, ANIM, ANMF, unknown
    if ((type === 'VP8 ' || type === 'VP8L') && (!width || !height)) fail('empty bitstream');
    offset = data + length + (length & 1);
  }
  if (!width || !height) fail('no bitstream');
  if (canvas && (canvas.width !== width || canvas.height !== height)) fail('canvas mismatch');
  return { width, height, chunks };
}

// Throws unless the output is canonical and exactly the requested size.
export function assertCanonicalWebp(bytes: Uint8Array, width: number, height: number): void {
  const shape = inspectCanonicalWebp(bytes);
  if (shape.width !== width || shape.height !== height) throw new Error(`non-canonical WebP: ${shape.width}x${shape.height}`);
}
