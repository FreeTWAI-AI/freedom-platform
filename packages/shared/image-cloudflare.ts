import { Problem } from './problem.js';
import { imageProcessingUnavailable, type ImageNormalizeSpec, type ImageProcessor } from './image-runtime.js';
import { assertCompleteRaster } from './image-container.js';
import { assertCanonicalWebp } from './image-webp.js';

// Structural subset of workers-types `ImagesBinding` (env.IMAGES), so this
// module needs neither the Workers types package nor a global binding.
export interface ImagesInfo { readonly format: string; readonly fileSize?: number; readonly width?: number; readonly height?: number }
export interface ImagesTransform {
  width: number; height: number;
  fit: 'cover' | 'pad';
  gravity?: 'center';
  background?: string;
}
export interface ImagesOutputOptions { format: 'image/webp'; quality: number; anim: false }
export interface ImagesTransformationResult { contentType(): string; image(): ReadableStream<Uint8Array> }
export interface ImagesTransformer {
  transform(transform: ImagesTransform): ImagesTransformer;
  output(options: ImagesOutputOptions): Promise<ImagesTransformationResult>;
}
export interface ImagesBinding {
  info(stream: ReadableStream<Uint8Array>): Promise<ImagesInfo>;
  input(stream: ReadableStream<Uint8Array>): ImagesTransformer;
}
export interface CloudflareImageOptions { readonly timeoutMs?: number }

// The only error code the binding documents: "not an image". Other codes and
// non-binding errors are operational, so they surface as 503 rather than
// blaming the member's file. Remote runs may widen this list with evidence.
const INVALID_INPUT_CODES = new Set([9412]);
const DEFAULT_TIMEOUT_MS = 10_000;
// Our own verdict about this file (callers map plain errors to 422).
class ImageRejected extends Error {}

class Deadline {
  readonly signal: Promise<never>;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(ms: number) {
    this.signal = new Promise<never>((_, reject) => { this.timer = setTimeout(() => reject(imageProcessingUnavailable()), ms); });
    this.signal.catch(() => {}); // Rejection is observed through race(); avoid an unhandled rejection after success.
  }
  race<T>(work: Promise<T>): Promise<T> { return Promise.race([work, this.signal]); }
  clear() { clearTimeout(this.timer); }
}

async function readBounded(stream: ReadableStream<Uint8Array>, max: number, deadline: Deadline): Promise<Uint8Array> {
  const reader = stream.getReader(), parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await deadline.race(reader.read());
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new ImageRejected('image output chunk is not bytes');
      total += value.byteLength;
      if (total > max) throw new ImageRejected('image output exceeds the size limit');
      parts.push(value);
    }
  } catch (error) {
    // Stop the service stream on cap, timeout or bad chunks; never keep partial bytes.
    reader.cancel().catch(() => {});
    throw error;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.byteLength; }
  return out;
}

const streamOf = (bytes: Uint8Array) => new Blob([new Uint8Array(bytes)]).stream();
const isImagesError = (error: unknown): error is { code: number } => typeof (error as { code?: unknown } | null)?.code === 'number';

// Request-scoped processor over the Worker's Images binding. Callers have
// already enforced byte size, signature/MIME and animation chunks.
export function createCloudflareImageProcessor(binding: ImagesBinding | undefined, options: CloudflareImageOptions = {}): ImageProcessor {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!binding || typeof binding.info !== 'function' || typeof binding.input !== 'function') {
    return Object.freeze({ name: 'cloudflare-images-missing', normalize: async () => { throw imageProcessingUnavailable(); } });
  }
  return Object.freeze({
    name: 'cloudflare-images',
    async normalize(bytes: Buffer, spec: ImageNormalizeSpec): Promise<Buffer> {
      // The service's decoder warnings are not visible, so truncated or
      // animated containers are refused here before any service call.
      assertCompleteRaster(bytes, spec.format, spec.maxDimension, spec.maxPixels);
      const deadline = new Deadline(timeoutMs), { width, height, fit, background, quality } = spec.output;
      try {
        const info = await deadline.race(binding.info(streamOf(bytes)));
        const w = info?.width, h = info?.height;
        if (info?.format !== `image/${spec.format}` || !Number.isInteger(w) || !Number.isInteger(h) || w! < 1 || h! < 1
          || w! > spec.maxDimension || h! > spec.maxDimension || w! * h! > spec.maxPixels) throw new ImageRejected('image rejected by info bounds');
        // Cloudflare `contain` does not fill the box; `pad` matches sharp contain + background.
        const transform: ImagesTransform = fit === 'cover' ? { width, height, fit: 'cover', gravity: 'center' } : { width, height, fit: 'pad', background };
        // WebP output is a full decode/re-encode that drops metadata; anim:false
        // is only a backstop because animated input never reaches this call.
        const result = await deadline.race(binding.input(streamOf(bytes)).transform(transform).output({ format: 'image/webp', quality, anim: false }));
        if (result.contentType() !== 'image/webp') throw new ImageRejected('image output is not WebP');
        const output = await readBounded(result.image(), spec.maxOutputBytes, deadline);
        try { assertCanonicalWebp(output, width, height); } catch (error) { throw new ImageRejected(String(error)); }
        return Buffer.from(output.buffer, output.byteOffset, output.byteLength);
      } catch (error) {
        if (error instanceof Problem || error instanceof ImageRejected) throw error;
        if (isImagesError(error) && INVALID_INPUT_CODES.has(error.code)) throw new ImageRejected(`image rejected by binding (${error.code})`);
        throw imageProcessingUnavailable();
      } finally {
        deadline.clear();
      }
    },
  });
}
