import fs from 'node:fs';
import path from 'node:path';
import { parseProgressLog, deriveRuntimeWeights, renderRuntimeWeightsModule } from '../../packages/contribution-tools/runtime-weights.mjs';

function parseArgs(argv) {
  const args = { logs: [] };
  let i = 2;
  while (i < argv.length) {
    if (argv[i] === '--root' && i + 1 < argv.length && args.root === undefined) {
      args.root = argv[i + 1];
      i += 2;
    } else if (argv[i] === '--note' && i + 1 < argv.length && args.note === undefined) {
      args.note = argv[i + 1];
      i += 2;
    } else if (argv[i] === '--output' && i + 1 < argv.length && args.output === undefined) {
      args.output = argv[i + 1];
      i += 2;
    } else if (argv[i] === '--costs-output' && i + 1 < argv.length && args.costsOutput === undefined) {
      args.costsOutput = argv[i + 1];
      i += 2;
    } else if (argv[i] === '--log' && i + 1 < argv.length) {
      args.logs.push(argv[i + 1]);
      i += 2;
    } else {
      return null;
    }
  }
  if (!args.root || !args.note || !args.output || !args.costsOutput || args.logs.length === 0) {
    return null;
  }
  return args;
}

const args = parseArgs(process.argv);
if (!args) {
  process.stderr.write('invalid_derive_runtime_weights_arguments\n');
  process.exit(2);
}

const maps = [];
for (const logFile of args.logs) {
  let text;
  try {
    text = fs.readFileSync(logFile, 'utf8');
  } catch (e) {
    process.stderr.write(`Failed to read log: ${logFile}\n`);
    process.exit(1);
  }
  try {
    const map = parseProgressLog(text);
    if (map.size === 0) {
      process.stderr.write(`Empty final segment in log: ${logFile}\n`);
      process.exit(1);
    }
    maps.push(map);
  } catch (e) {
    process.stderr.write(`Parse error in ${logFile}: ${e.message}\n`);
    process.exit(1);
  }
}

const { weights, milliseconds } = deriveRuntimeWeights(maps);

const finalWeights = {};
const finalMs = {};
const dropped = [];

const sortedKeys = Object.keys(weights).sort();
for (const key of sortedKeys) {
  const fullPath = path.join(args.root, key);
  let isFile = false;
  try {
    const stat = fs.lstatSync(fullPath);
    isFile = stat.isFile();
  } catch (e) {
    // Missing
  }
  if (isFile) {
    finalWeights[key] = weights[key];
    const strippedKey = key.replace(/^tests\/runtime\//, '');
    finalMs[strippedKey] = milliseconds[key];
  } else {
    dropped.push(key);
    process.stderr.write(`Dropped: ${key}\n`);
  }
}

let moduleCode;
try {
  moduleCode = renderRuntimeWeightsModule(finalWeights, args.note);
} catch (e) {
  process.stderr.write(`${e.message}\n`);
  process.exit(1);
}

fs.writeFileSync(args.output, moduleCode, 'utf8');

const costsData = {
  source: args.note,
  measurement: 'per-file minimum of serial completed-file progress deltas across the listed hosted runs; includes file loading',
  milliseconds: finalMs
};
fs.writeFileSync(args.costsOutput, JSON.stringify(costsData, null, 2) + '\n', 'utf8');

let totalWeight = 0;
for (const w of Object.values(finalWeights)) {
  totalWeight += w;
}

console.log(`${args.logs.length} logs, ${Object.keys(finalWeights).length} files, total weight ${totalWeight}, ${dropped.length} dropped`);
