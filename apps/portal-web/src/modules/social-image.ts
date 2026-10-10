// Browser input and network output have different budgets. Members select photos;
// the browser prepares a bounded raster before the existing server validation.
export const SOCIAL_IMAGE_INPUT_BYTES = 20 * 1024 * 1024;
const OUTPUT_BYTES = 512 * 1024, MAX_PIXELS = 64_000_000;
const invalid = () => new Error('圖片無法讀取，請選擇完整的靜態 JPEG、PNG 或 WebP 圖片。');

export function socialImageProblem(file: File): string {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return '請選擇 JPEG、PNG 或 WebP 圖片。';
  if (!file.size) return '圖片是空的，請重新選取。';
  return file.size > SOCIAL_IMAGE_INPUT_BYTES ? '這張圖片超過 20 MB，請選擇較小的原始照片。' : '';
}

// Check dimensions and animation before allocating decoded pixels. MIME alone
// cannot turn an SVG or animated raster into an accepted static photograph.
function inspect(bytes: ArrayBuffer, mime: string) {
  const data = new DataView(bytes), raw = new Uint8Array(bytes);
  const tag = (offset: number, length: number) => String.fromCharCode(...raw.subarray(offset, offset + length));
  let width = 0, height = 0;
  if (mime === 'image/png' && raw.length >= 33 && tag(1, 3) === 'PNG' && raw[0] === 137 && tag(12, 4) === 'IHDR') {
    width = data.getUint32(16); height = data.getUint32(20);
    for (let offset = 8; offset + 12 <= raw.length;) {
      const length = data.getUint32(offset), type = tag(offset + 4, 4);
      if (length > raw.length - offset - 12 || type === 'acTL') throw invalid();
      offset += length + 12;
      if (type === 'IEND') break;
    }
  } else if (mime === 'image/jpeg' && raw[0] === 255 && raw[1] === 216) {
    for (let offset = 2; offset + 4 <= raw.length;) {
      if (raw[offset++] !== 255) throw invalid();
      while (raw[offset] === 255) offset++;
      const marker = raw[offset++];
      if (marker === 218 || marker === 217) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      const length = data.getUint16(offset);
      if (length < 2 || offset + length > raw.length) throw invalid();
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)) {
        if (length < 8) throw invalid();
        height = data.getUint16(offset + 3); width = data.getUint16(offset + 5); break;
      }
      offset += length;
    }
  } else if (mime === 'image/webp' && raw.length >= 20 && tag(0, 4) === 'RIFF' && tag(8, 4) === 'WEBP') {
    const uint24 = (offset: number) => raw[offset] + raw[offset + 1] * 256 + raw[offset + 2] * 65536;
    for (let offset = 12; offset + 8 <= raw.length;) {
      const type = tag(offset, 4), length = data.getUint32(offset + 4, true), start = offset + 8;
      if (length > raw.length - start || type === 'ANIM' || type === 'ANMF') throw invalid();
      if (type === 'VP8X' && length >= 10) {
        if (raw[start] & 2) throw invalid();
        width = uint24(start + 4) + 1; height = uint24(start + 7) + 1;
      } else if (!width && type === 'VP8 ' && length >= 10) {
        width = data.getUint16(start + 6, true) & 16383; height = data.getUint16(start + 8, true) & 16383;
      } else if (!width && type === 'VP8L' && length >= 5 && raw[start] === 47) {
        const bits = data.getUint32(start + 1, true);
        width = (bits & 16383) + 1; height = ((bits >>> 14) & 16383) + 1;
      }
      offset = start + length + (length & 1);
    }
  }
  if (!width || !height) throw invalid();
  if (width * height > MAX_PIXELS) throw new Error('這張圖片的解析度過高，請選擇一般照片版本。');
}

export async function prepareSocialImage(file: File): Promise<File> {
  const problem = socialImageProblem(file);
  if (problem) throw new Error(problem);
  let bitmap: ImageBitmap | undefined;
  const canvas = document.createElement('canvas');
  try {
    inspect(await file.arrayBuffer(), file.type);
    bitmap = await createImageBitmap(file, {imageOrientation: 'from-image'});
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > MAX_PIXELS) throw invalid();
    const context = canvas.getContext('2d');
    if (!context) throw invalid();
    // Preserve orientation, aspect ratio and transparency; never enlarge small images.
    for (const edge of [1600, 1200, 960, 640]) {
      const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.88, 0.76, 0.64]) {
        const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/webp', quality));
        // Browsers without a WebP encoder return PNG. Both are valid server inputs.
        if (blob && ['image/webp', 'image/png'].includes(blob.type) && blob.size > 0 && blob.size <= OUTPUT_BYTES) {
          return new File([blob], file.name, {type: blob.type, lastModified: file.lastModified});
        }
      }
    }
    throw new Error('這張圖片暫時無法處理，請重新選取或換一張照片。');
  } catch (error) {
    if (error instanceof Error && !(error instanceof DOMException) && error.message.includes('圖片')) throw error;
    throw invalid();
  } finally {
    bitmap?.close(); canvas.width = 0; canvas.height = 0;
  }
}
