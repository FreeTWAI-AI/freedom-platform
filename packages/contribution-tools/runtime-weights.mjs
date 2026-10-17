import { PROGRESS_MAX_ELAPSED_MS } from './test-reporter.mjs';

// A timed-out partition's final segment still holds exact durations for the
// files it completed; only callers that name such a log pass `partial`. The
// Explicit partial input may omit files with saturated endpoints; strict input
// rejects the whole segment. Neither mode admits malformed endpoint values.
const saturated = value => [1_200_000, PROGRESS_MAX_ELAPSED_MS].includes(value);
export function parseProgressLog(text, { partial = false } = {}) {
  const lines = text.split('\n');
  const records = [];
  for (const line of lines) {
    const marker = 'freedom.test-progress ';
    const markerIndex = line.indexOf(marker);
    if (markerIndex !== -1) {
      const jsonStr = line.slice(markerIndex + marker.length);
      try { records.push(JSON.parse(jsonStr)); } catch {}
    }
  }

  const summaryIndexes = [];
  for (let i = 0; i < records.length; i++) {
    if (records[i].schema === 'freedom.test-file-progress-summary/v1') {
      summaryIndexes.push(i);
    }
  }

  let segmentStart = 0;
  if (summaryIndexes.length >= 2) {
    segmentStart = summaryIndexes[summaryIndexes.length - 2] + 1;
  }
  const lastSummaryIndex = summaryIndexes.length > 0 ? summaryIndexes[summaryIndexes.length - 1] : -1;

  if (lastSummaryIndex === -1) {
    throw new Error('incomplete_progress_log');
  }

  const lastSummary = records[lastSummaryIndex];
  const complete = lastSummary.incomplete === false &&
    lastSummary.selected_count === lastSummary.started_count &&
    lastSummary.selected_count === lastSummary.completed_count;
  const timedOut = partial && lastSummary.incomplete === true &&
    Number.isSafeInteger(lastSummary.completed_count) && lastSummary.completed_count >= 0 &&
    [lastSummary.completed_count, lastSummary.completed_count + 1].includes(lastSummary.started_count) &&
    Number.isSafeInteger(lastSummary.selected_count) && lastSummary.started_count <= lastSummary.selected_count;
  if (!complete && !timedOut) {
    throw new Error('incomplete_progress_log');
  }

  const segment = records.slice(segmentStart, lastSummaryIndex);

  const started = new Map();
  const completed = new Map();

  for (const record of segment) {
    if (record.schema === 'freedom.test-file-progress/v1') {
      if (!/^tests\/runtime\/[a-z][a-z0-9_-]*\.test\.ts$/.test(record.path)) {
        throw new Error('invalid_progress_path');
      }
      if (record.event === 'started' || record.event === 'completed') {
        if (!Number.isSafeInteger(record.elapsed_ms) || record.elapsed_ms < 0 || record.elapsed_ms > PROGRESS_MAX_ELAPSED_MS) {
          throw new Error('inconsistent_progress_log');
        }
        // Both reporter generations clamp at their ceiling. Even a complete
        // file-count summary cannot recover time lost to that saturation.
        // Conservatively reject an exact ceiling, including a coincidental hit.
        if (!partial && saturated(record.elapsed_ms)) {
          throw new Error('saturated_progress_timing');
        }
      }
      if (record.event === 'started') {
        if (started.has(record.path)) throw new Error('inconsistent_progress_log');
        started.set(record.path, record);
      } else if (record.event === 'completed') {
        if (completed.has(record.path)) throw new Error('inconsistent_progress_log');
        completed.set(record.path, record);
      }
    }
  }

  if (completed.size !== lastSummary.completed_count || started.size !== lastSummary.started_count) {
    throw new Error('inconsistent_progress_log');
  }

  const result = new Map();
  for (const [path, compRecord] of completed.entries()) {
    const startRecord = started.get(path);
    if (!startRecord) throw new Error('inconsistent_progress_log');

    const duration = compRecord.elapsed_ms - startRecord.elapsed_ms;
    if (!Number.isSafeInteger(duration) || duration < 0) {
      throw new Error('inconsistent_progress_log');
    }
    if (partial && (saturated(startRecord.elapsed_ms) || saturated(compRecord.elapsed_ms))) continue;
    result.set(path, duration);
  }

  return result;
}

export function deriveRuntimeWeights(maps) {
  const minMs = new Map();
  for (const map of maps) {
    for (const [path, ms] of map.entries()) {
      if (!minMs.has(path) || ms < minMs.get(path)) {
        minMs.set(path, ms);
      }
    }
  }

  const sortedKeys = Array.from(minMs.keys()).sort();
  const milliseconds = {};
  const weights = {};

  for (const key of sortedKeys) {
    const ms = minMs.get(key);
    milliseconds[key] = ms;
    weights[key] = Math.max(1, Math.ceil(ms / 1000));
  }

  return { weights, milliseconds };
}

export function renderRuntimeWeightsModule(weights, note) {
  if (typeof note !== 'string' || note.length > 300 || note.includes('*/') || note.includes('\n') || note.includes('\r') || note.includes('`')) {
    throw new Error('invalid_weights_note');
  }

  let code = `// Reviewed scheduling estimates only, never pass evidence or caller input.
// ${note}
// Rule: per-file minimum of serial completed-file progress deltas across the listed hosted
// runs, rounded up to whole seconds (at least 1). Files not listed use the default.
// Generated by scripts/ci/derive-runtime-weights.mjs; see packages/contribution-tools/runtime-matrix.md.
export const DEFAULT_RUNTIME_FILE_WEIGHT = 10;
export const RUNTIME_FILE_WEIGHTS = Object.freeze({\n`;

  const sortedKeys = Object.keys(weights).sort();
  for (const key of sortedKeys) {
    code += `  '${key}': ${weights[key]},\n`;
  }
  code += `});\n`;

  return code;
}
