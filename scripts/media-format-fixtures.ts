import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

/** Local synthetic bytes for accepted event-video and highlight formats.
 * Generating or loading these files is not live R2, staging, or production
 * acceptance. Asset-storage still treats an `ftyp` header as enough for MP4;
 * this tool keeps a decodable H.264 file so tests can tell those apart. */
export const MEDIA_FIXTURE_SCHEMA = 'freedom.media-format-fixtures/v1';
const root = join(dirname(fileURLToPath(import.meta.url)), '../tests/media-fixtures');
const videoName = 'event-video-160x90.mp4';
const photoName = 'highlight-photo.png';
const posterName = 'highlight-poster.jpg';
const stillName = 'highlight-still.webp';

export interface MediaFixtureFile {
  readonly file: string;
  readonly contentType: 'video/mp4' | 'image/png' | 'image/jpeg' | 'image/webp';
  readonly byteSize: number;
  readonly sha256: string;
}
export interface MediaFixtureManifest {
  readonly schema: typeof MEDIA_FIXTURE_SCHEMA;
  readonly evidence: 'local_synthetic_fixture';
  readonly liveAcceptance: false;
  readonly video: MediaFixtureFile & {
    readonly codec: 'h264';
    readonly pixFmt: 'yuv420p';
    readonly width: 160;
    readonly height: 90;
    readonly durationSeconds: number;
    readonly seekSeconds: 1.8;
    readonly boxes: readonly string[];
  };
  readonly highlights: {
    readonly photo: MediaFixtureFile & { readonly kind: 'photo'; readonly width: number; readonly height: number };
    readonly poster: MediaFixtureFile & { readonly kind: 'poster'; readonly width: number; readonly height: number };
    readonly still: MediaFixtureFile & { readonly kind: 'photo'; readonly width: number; readonly height: number };
  };
  readonly links: {
    readonly youtube: { readonly input: string; readonly url: string; readonly platform: 'youtube'; readonly title: string; readonly videoId: string };
    readonly other: { readonly input: string; readonly url: string; readonly platform: 'other'; readonly title: string };
  };
}

export function mp4TopLevelBoxes(bytes: Uint8Array): { type: string; offset: number; size: number }[] {
  const boxes: { type: string; offset: number; size: number }[] = [];
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    let size = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > bytes.length) break;
      const large = new DataView(bytes.buffer, bytes.byteOffset + offset + 8, 8).getBigUint64(0);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) break;
      size = Number(large);
      header = 16;
    } else if (size === 0) size = bytes.length - offset;
    if (!/^[A-Za-z0-9]{4}$/.test(type) || size < header || offset + size > bytes.length) break;
    boxes.push({ type, offset, size });
    offset += size;
  }
  return boxes;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function fileRecord(file: string, contentType: MediaFixtureFile['contentType'], bytes: Buffer): MediaFixtureFile {
  return { file, contentType, byteSize: bytes.length, sha256: sha256(bytes) };
}
async function probeVideo(path: string): Promise<{ codec: 'h264'; pixFmt: 'yuv420p'; width: 160; height: 90; durationSeconds: number }> {
  const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,pix_fmt,width,height,duration', '-of', 'json', path], { encoding: 'utf8' });
  if (probe.status !== 0) throw new Error('ffprobe_failed');
  const stream = JSON.parse(probe.stdout).streams?.[0];
  const durationSeconds = Number(stream?.duration);
  if (stream?.codec_name !== 'h264' || stream?.pix_fmt !== 'yuv420p' || stream?.width !== 160 || stream?.height !== 90 || !Number.isFinite(durationSeconds) || durationSeconds < 2) {
    throw new Error('mp4_probe_mismatch');
  }
  return { codec: 'h264', pixFmt: 'yuv420p', width: 160, height: 90, durationSeconds: Math.round(durationSeconds * 1000) / 1000 };
}

export async function generateAcceptedMediaFixtures(directory = root): Promise<MediaFixtureManifest> {
  await mkdir(directory, { recursive: true });
  const videoPath = join(directory, videoName);
  const encoded = spawnSync('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', 'color=c=0x3044ff:s=160x90:d=2.4:r=10',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-profile:v', 'baseline', '-level', '3.0',
    '-g', '10', '-keyint_min', '10', '-sc_threshold', '0', '-bf', '0',
    '-movflags', '+faststart', '-an', videoPath,
  ], { encoding: 'utf8' });
  if (encoded.status !== 0) throw new Error('ffmpeg_failed');
  const videoBytes = await readFile(videoPath);
  const boxes = mp4TopLevelBoxes(videoBytes).map(box => box.type);
  if (videoBytes.subarray(4, 8).toString('ascii') !== 'ftyp' || !boxes.includes('moov') || !boxes.includes('mdat')) throw new Error('mp4_structure_mismatch');
  const probed = await probeVideo(videoPath);
  // Landscape highlight output is 1600x1200. These sources are 4:3 so contain is a
  // plain squeeze. A square source needs a side border, and this workerd Images
  // build returns only the squeezed frame, which the canonical-size check rejects.
  const photo = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#337788' } }).png().toBuffer();
  const poster = await sharp({ create: { width: 48, height: 36, channels: 3, background: '#c4ff20' } }).jpeg({ quality: 80 }).toBuffer();
  const still = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#14161b' } }).webp({ quality: 80 }).toBuffer();
  await writeFile(join(directory, photoName), photo);
  await writeFile(join(directory, posterName), poster);
  await writeFile(join(directory, stillName), still);
  const photoMeta = await sharp(photo).metadata();
  const posterMeta = await sharp(poster).metadata();
  const stillMeta = await sharp(still).metadata();
  if (photoMeta.format !== 'png' || photoMeta.width !== 32 || photoMeta.height !== 24
    || posterMeta.format !== 'jpeg' || posterMeta.width !== 48 || posterMeta.height !== 36
    || stillMeta.format !== 'webp' || stillMeta.width !== 64 || stillMeta.height !== 48 || stillMeta.pages) throw new Error('highlight_format_mismatch');
  const manifest: MediaFixtureManifest = {
    schema: MEDIA_FIXTURE_SCHEMA,
    evidence: 'local_synthetic_fixture',
    liveAcceptance: false,
    video: { ...fileRecord(videoName, 'video/mp4', videoBytes), ...probed, seekSeconds: 1.8, boxes },
    highlights: {
      photo: { ...fileRecord(photoName, 'image/png', photo), kind: 'photo', width: photoMeta.width ?? 0, height: photoMeta.height ?? 0 },
      poster: { ...fileRecord(posterName, 'image/jpeg', poster), kind: 'poster', width: posterMeta.width ?? 0, height: posterMeta.height ?? 0 },
      still: { ...fileRecord(stillName, 'image/webp', still), kind: 'photo', width: stillMeta.width ?? 0, height: stillMeta.height ?? 0 },
    },
    links: {
      youtube: {
        input: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ&utm_source=fixture#t=1',
        url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
        platform: 'youtube', title: 'YouTube 影片', videoId: 'aqz-KE-bpKQ',
      },
      other: {
        input: 'https://example.com/highlight-fixture',
        url: 'https://example.com/highlight-fixture',
        platform: 'other', title: '相關連結',
      },
    },
  };
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

export interface LoadedMediaFixtures {
  readonly manifest: MediaFixtureManifest;
  readonly directory: string;
  readonly video: Buffer;
  readonly photo: Buffer;
  readonly poster: Buffer;
  readonly still: Buffer;
}
function matches(record: MediaFixtureFile, bytes: Buffer): boolean {
  return bytes.length === record.byteSize && sha256(bytes) === record.sha256;
}
export async function loadAcceptedMediaFixtures(directory = root): Promise<LoadedMediaFixtures> {
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as MediaFixtureManifest;
  if (manifest.schema !== MEDIA_FIXTURE_SCHEMA || manifest.evidence !== 'local_synthetic_fixture' || manifest.liveAcceptance !== false) {
    throw new Error('media_fixture_manifest_mismatch');
  }
  const video = await readFile(join(directory, manifest.video.file));
  const photo = await readFile(join(directory, manifest.highlights.photo.file));
  const poster = await readFile(join(directory, manifest.highlights.poster.file));
  const still = await readFile(join(directory, manifest.highlights.still.file));
  if (!matches(manifest.video, video) || !matches(manifest.highlights.photo, photo) || !matches(manifest.highlights.poster, poster) || !matches(manifest.highlights.still, still)) {
    throw new Error('media_fixture_digest_mismatch');
  }
  const boxes = mp4TopLevelBoxes(video).map(box => box.type);
  if (video.subarray(4, 8).toString('ascii') !== 'ftyp' || !boxes.includes('moov') || !boxes.includes('mdat')) throw new Error('media_fixture_mp4_structure');
  return { manifest, directory, video, photo, poster, still };
}

async function verifyAcceptedMediaFixtures(): Promise<void> {
  const loaded = await loadAcceptedMediaFixtures();
  const probed = await probeVideo(join(loaded.directory, loaded.manifest.video.file));
  if (probed.durationSeconds !== loaded.manifest.video.durationSeconds || probed.width !== 160 || probed.height !== 90) throw new Error('media_fixture_probe_mismatch');
  const photo = await sharp(loaded.photo).metadata();
  const poster = await sharp(loaded.poster).metadata();
  const still = await sharp(loaded.still).metadata();
  if (photo.format !== 'png' || photo.width !== 32 || photo.height !== 24
    || poster.format !== 'jpeg' || poster.width !== 48 || poster.height !== 36
    || still.format !== 'webp' || still.width !== 64 || still.height !== 48 || still.pages) throw new Error('media_fixture_image_mismatch');
  process.stdout.write(`media fixtures verified ${loaded.manifest.video.sha256.slice(0, 12)} video=${loaded.video.length} photo=${loaded.photo.length} poster=${loaded.poster.length} still=${loaded.still.length}\n`);
}

const command = process.argv[2];
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const run = command === 'generate' ? generateAcceptedMediaFixtures() : command === 'verify' ? verifyAcceptedMediaFixtures() : Promise.reject(new Error('usage: generate | verify'));
  run.catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : 'media_fixture_failed'}\n`);
    process.exitCode = 1;
  });
}
