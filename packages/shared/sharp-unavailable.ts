import { Problem } from './problem.js';

// Worker bundle alias target for `sharp`: native libvips is unavailable there,
// so any unscoped image decode fails closed instead of storing input bytes.
export default function sharp(): never {
  throw new Problem(503, 'image_processing_unavailable', '目前無法處理圖片上傳，請稍後再試。');
}
