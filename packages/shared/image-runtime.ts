import { AsyncLocalStorage } from 'node:async_hooks';
import { Problem } from './problem.js';
import { nodeImageProcessor } from './image-node.js';
import { assertCanonicalWebp } from './image-webp.js';

export type RasterFormat = 'png' | 'jpeg' | 'webp';
export interface ImageOutputSpec {
  readonly width: number; readonly height: number;
  readonly fit: 'cover' | 'contain';
  readonly background?: string;
  readonly quality: number; readonly effort: number;
}
// Callers have already checked byte size, declared MIME, signature and
// animation chunks; a processor must still fully decode and enforce limits.
export interface ImageNormalizeSpec {
  readonly purpose: 'avatar' | 'skill_cover';
  readonly format: RasterFormat;
  readonly maxDimension: number;
  readonly maxPixels: number;
  // Callers still apply their own limit; streaming processors stop reading here.
  readonly maxOutputBytes: number;
  readonly output: ImageOutputSpec;
}
export interface ImageProcessor {
  readonly name: string;
  // Returns canonical WebP without metadata, or throws. Never returns input bytes.
  normalize(bytes: Buffer, spec: ImageNormalizeSpec): Promise<Buffer>;
}

const scope = new AsyncLocalStorage<ImageProcessor>();

// Request-scoped choice of decoder; there is deliberately no global setter.
export function runWithImageProcessor<T>(processor: ImageProcessor, callback: () => T): T {
  if (!processor || typeof processor.normalize !== 'function') throw new TypeError('image processor requires normalize()');
  return scope.run(processor, callback);
}
export function currentImageProcessor(): ImageProcessor {
  return scope.getStore() ?? nodeImageProcessor;
}

export const imageProcessingUnavailable = () => new Problem(503, 'image_processing_unavailable', '目前無法處理圖片上傳，請稍後再試。');
// For runtimes without a verified complete decoder: images are refused, never stored raw.
export function createUnavailableImageProcessor(): ImageProcessor {
  return Object.freeze({ name: 'unavailable', normalize: async () => { throw imageProcessingUnavailable(); } });
}

export async function normalizeImage(bytes: Buffer, spec: ImageNormalizeSpec): Promise<Buffer> {
  const frozen: ImageNormalizeSpec = Object.freeze({ ...spec, output: Object.freeze({ ...spec.output }) });
  // The processor gets its own copy so it cannot alter bytes the caller digests.
  const output = await currentImageProcessor().normalize(Buffer.from(bytes), frozen);
  if (!Buffer.isBuffer(output)) throw new Error('image processor returned non-canonical output');
  // Deliberately no output-equals-input check: re-encoding an already canonical
  // flat image can be byte-identical. The container check is the guarantee.
  assertCanonicalWebp(output, frozen.output.width, frozen.output.height);
  return output;
}
