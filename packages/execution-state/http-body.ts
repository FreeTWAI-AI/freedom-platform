import { parseBoundedJson } from './decode.js';
import { snapshotBoundedBytes } from '../asset-storage/index.js';
import { Problem, requireCondition } from '../shared/problem.js';

const BODY_BYTES = 32768, BODY_CHUNKS = 128, BODY_MS = 5000;

/** Shared closed JSON wire reader. Cancellation never extends the deadline. */
export async function readBoundedHttpJson(request: Request): Promise<unknown> {
  requireCondition(/^application\/json(?:;\s*charset=utf-8)?$(?![\s\S])/i.test(request.headers.get('Content-Type') ?? ''),415,'json_required','JSON required.');
  const length = request.headers.get('Content-Length') ?? undefined;
  requireCondition(length === undefined || /^(0|[1-9][0-9]*)$(?![\s\S])/.test(length) && Number(length) <= BODY_BYTES,
    413,'body_too_large','Body too large.');
  requireCondition(request.body,400,'invalid_body','Body required.');
  const reader = request.body.getReader(), buffer = new Uint8Array(BODY_BYTES);
  let timer: ReturnType<typeof setTimeout> | undefined, size = 0, chunks = 0, complete = false;
  let abort: (() => void) | undefined;
  const deadline = new Promise<never>((_,reject) => {
    timer = setTimeout(() => reject(new Problem(408,'body_timeout','Body timeout.')),BODY_MS);
    abort = () => reject(new Problem(400,'invalid_body','Body aborted.'));
    request.signal.addEventListener('abort',abort,{once:true});
    if (request.signal.aborted) abort();
  });
  try {
    for (;;) {
      const next = await Promise.race([reader.read(),deadline]);
      if (next.done) { complete = true; break; }
      requireCondition(++chunks <= BODY_CHUNKS,413,'body_too_large','Body too large.');
      let bytes: Uint8Array;
      try { bytes = snapshotBoundedBytes(next.value,BODY_BYTES); }
      catch (error) {
        if ((error as { code?: string })?.code === 'too_large') throw new Problem(413,'body_too_large','Body too large.');
        throw new Problem(400,'invalid_body','Invalid body chunk.');
      }
      requireCondition(bytes.length <= BODY_BYTES-size,413,'body_too_large','Body too large.');
      buffer.set(bytes,size); size += bytes.length;
    }
    requireCondition(length === undefined || Number(length) === size,400,'invalid_body','Invalid body length.');
    const raw = new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(buffer.subarray(0,size));
    return parseBoundedJson(raw);
  } catch (error) {
    if (error instanceof Problem) throw error;
    throw new Problem(400,'invalid_json','Invalid JSON.');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abort) request.signal.removeEventListener('abort',abort);
    // A hostile/failed source cannot make cancellation hold the request open.
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

