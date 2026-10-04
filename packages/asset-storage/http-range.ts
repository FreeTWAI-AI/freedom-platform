import { OBJECT_IO_MAX_BYTES, type ObjectRange } from "./index.js";

/** Closed ObjectStore MIME names. The domain decides which profile applies. */
const ALLOWED_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "video/mp4",
  "video/webm",
  "text/plain",
  "text/markdown",
  "image/png",
  "image/jpeg",
  "image/webp",
]);

const ETAG_RE = /^[A-Za-z0-9_-]{1,128}$/;
const DECIMAL_GUARD = 4096;

export class HTTPRangeError extends Error {
  readonly code = "HTTP_RANGE_INPUT" as const;
  constructor() {
    super("HTTP_RANGE_INPUT");
    this.name = "HTTPRangeError";
  }
}

export type ObjectHttpPlan = {
  status: 200 | 206 | 416;
  range?: ObjectRange;
  headers: Readonly<Record<string, string>>;
  sendBody: boolean;
};

type Span = { kind: "ignore" } | { kind: "unsat" } | { kind: "hit"; range: ObjectRange };

function assertTrusted(byteSize: number, contentType: string, etag: string): void {
  if (!Number.isSafeInteger(byteSize) || byteSize < 1 || byteSize > OBJECT_IO_MAX_BYTES) {
    throw new HTTPRangeError();
  }
  if (typeof contentType !== "string" || !ALLOWED_CONTENT_TYPES.has(contentType)
    || typeof etag !== "string" || !ETAG_RE.test(etag)) throw new HTTPRangeError();
}

/** Digit string vs size. Never builds a BigInt from more than DECIMAL_GUARD significant digits. */
function classify(dec: string, size: number): bigint | "ge" | "bad" {
  const len = dec.length;
  if (len === 0) return "bad";
  for (let i = 0; i < len; i++) {
    const c = dec.charCodeAt(i);
    if (c < 48 || c > 57) return "bad";
  }
  let start = 0;
  while (start < len - 1 && dec.charCodeAt(start) === 48) start++;
  if (len - start > DECIMAL_GUARD) return "ge";
  const n = BigInt(start === 0 ? dec : dec.slice(start));
  return n >= BigInt(size) ? "ge" : n;
}

function parseRange(header: string, size: number): Span {
  if (header.length > DECIMAL_GUARD) return { kind: "ignore" };
  const trimmed = header.trim();
  const eq = trimmed.indexOf("=");
  if (eq <= 0) return { kind: "ignore" };
  if (trimmed.slice(0, eq).trim().toLowerCase() !== "bytes") return { kind: "ignore" };
  const spec = trimmed.slice(eq + 1).trim();
  if (spec.length === 0 || spec.indexOf(",") !== -1) return { kind: "ignore" };
  if (spec.startsWith("-")) {
    const suffix = classify(spec.slice(1), size);
    if (suffix === "bad") return { kind: "ignore" };
    if (suffix === 0n) return { kind: "unsat" };
    if (suffix === "ge") return { kind: "hit", range: { offset: 0, length: size } };
    const length = Number(suffix);
    return { kind: "hit", range: { offset: size - length, length } };
  }
  const dash = spec.indexOf("-");
  if (dash <= 0) return { kind: "ignore" };
  const startC = classify(spec.slice(0, dash), size);
  if (startC === "bad") return { kind: "ignore" };
  const start = startC === "ge" ? size : Number(startC);
  const endRaw = spec.slice(dash + 1);
  if (endRaw.length === 0) return startC === "ge" ? { kind: "unsat" }
    : { kind: "hit", range: { offset: start, length: size - start } };
  const endC = classify(endRaw, size);
  if (endC === "bad") return { kind: "ignore" };
  if (startC === "ge" || (endC !== "ge" && endC < startC)) return { kind: "unsat" };
  const end = endC === "ge" ? size - 1 : Number(endC);
  return { kind: "hit", range: { offset: start, length: end - start + 1 } };
}

function strongIfRange(ifRange: string | null | undefined, etag: string): boolean {
  if (ifRange == null) return true;
  const value = ifRange.trim();
  if (value.length === 0) return false;
  return value === `"${etag}"`;
}

function headers(
  contentType: string,
  etag: string,
  length: number,
  contentRange?: string,
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {
    "accept-ranges": "bytes",
    "content-type": contentType,
    etag: `"${etag}"`,
    "content-length": String(length),
  };
  if (contentRange !== undefined) out["content-range"] = contentRange;
  return Object.freeze(out);
}

function plan(
  status: 200 | 206 | 416,
  hdrs: Readonly<Record<string, string>>,
  sendBody: boolean,
  range?: ObjectRange,
): ObjectHttpPlan {
  const body: ObjectHttpPlan = { status, headers: hdrs, sendBody };
  if (range !== undefined) body.range = Object.freeze(range);
  return Object.freeze(body);
}

export function planObjectHttpRequest(input: {
  method: "GET" | "HEAD";
  byteSize: number;
  contentType: string;
  etag: string;
  rangeHeader?: string | null;
  ifRangeHeader?: string | null;
}): ObjectHttpPlan {
  if (!input || (input.method !== "GET" && input.method !== "HEAD")
    || (input.rangeHeader != null && typeof input.rangeHeader !== "string")
    || (input.ifRangeHeader != null && typeof input.ifRangeHeader !== "string")) throw new HTTPRangeError();
  assertTrusted(input.byteSize, input.contentType, input.etag);
  const size = input.byteSize;
  const full = (): ObjectHttpPlan =>
    plan(200, headers(input.contentType, input.etag, size), input.method === "GET");
  if (input.method === "HEAD" || input.rangeHeader == null || input.rangeHeader === "") return full();
  const span = parseRange(input.rangeHeader, size);
  if (span.kind === "ignore" || !strongIfRange(input.ifRangeHeader, input.etag)) return full();
  if (span.kind === "unsat") {
    return plan(416, headers(input.contentType, input.etag, 0, `bytes */${size}`), false);
  }
  const { offset, length } = span.range;
  const end = offset + length - 1;
  return plan(
    206,
    headers(input.contentType, input.etag, length, `bytes ${offset}-${end}/${size}`),
    true,
    span.range,
  );
}
