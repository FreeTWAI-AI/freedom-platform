import sharp from 'sharp';
import type { ImageNormalizeSpec, ImageProcessor } from './image-runtime.js';

// The only module that imports sharp; Worker builds alias `sharp` away.
export const nodeImageProcessor: ImageProcessor = Object.freeze({
  name: 'node-sharp',
  async normalize(bytes: Buffer, spec: ImageNormalizeSpec) {
    const image = sharp(bytes, { limitInputPixels: spec.maxPixels, failOn: 'warning', sequentialRead: true, animated: false });
    const metadata = await image.metadata();
    if (metadata.format !== spec.format || !metadata.width || !metadata.height || metadata.width > spec.maxDimension || metadata.height > spec.maxDimension
      || metadata.width * metadata.height > spec.maxPixels || (metadata.pages ?? 1) !== 1) throw new Error('image rejected');
    const { width, height, fit, background, quality, effort } = spec.output;
    // No keepMetadata/withMetadata: EXIF, GPS, comments and ICC profiles are removed.
    // toBuffer performs the actual decode; header-only metadata is never stored.
    return image.autoOrient()
      .resize(width, height, fit === 'cover' ? { fit, position: 'centre' } : { fit, background })
      .webp({ quality, effort }).timeout({ seconds: 5 }).toBuffer();
  },
});
