import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

import {
  ECPAY_B2C_INVOICE_PATHS,
  ECPAY_B2C_INVOICE_PROFILE,
} from '../../modules/agent-commerce/providers/ecpay/b2c-invoice/index.js';
import {
  B2C_INVOICE_ISSUE_RESPONSE_LOWER_HEX,
  B2C_INVOICE_REQUEST_GOLDENS,
} from './ecpay-fixtures/b2c-invoice-vectors.js';
import {
  evaluateB2cInvoiceVectors,
  type B2cInvoiceWorkerEvaluation,
} from './ecpay-fixtures/b2c-invoice-worker.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '../..');

describe('ECPay B2C e-invoice profile (ecpay.invoice.b2c.v1) in workerd (Miniflare)', () => {
  let tempDir: string | undefined;
  let mf: Miniflare | undefined;
  let workerPayload: B2cInvoiceWorkerEvaluation;
  const nodePayload = evaluateB2cInvoiceVectors();

  before(async () => {
    const wranglerRoot = path.join(repoRoot, '.wrangler');
    fs.mkdirSync(wranglerRoot, { recursive: true });
    tempDir = fs.mkdtempSync(
      path.join(wranglerRoot, 'ecpay-b2c-invoice-workerd-'),
    );

    const outfile = path.join(tempDir, 'b2c-invoice-worker.mjs');
    await build({
      entryPoints: [path.join(testDir, 'ecpay-fixtures/b2c-invoice-worker.ts')],
      outfile,
      bundle: true,
      format: 'esm',
      target: 'es2023',
      platform: 'neutral',
      mainFields: ['browser', 'module', 'main'],
      conditions: ['workerd', 'worker', 'browser'],
      external: ['node:*'],
      logLevel: 'silent',
    });

    mf = new Miniflare(
      convertV4MiniflareOptions({
        workers: [
          {
            name: 'b2c-invoice-worker',
            modules: true,
            scriptPath: outfile,
            compatibilityDate: '2026-09-21',
            compatibilityFlags: ['nodejs_compat'],
          },
        ],
      }),
    );
    await mf.ready;

    const worker = await mf.getWorker('b2c-invoice-worker');
    const response = await worker.fetch('https://ecpay.internal/b2c-invoice');
    assert.equal(response.status, 200);
    workerPayload = (await response.json()) as B2cInvoiceWorkerEvaluation;
  });

  after(async () => {
    await mf?.dispose();
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      const wranglerRoot = path.join(repoRoot, '.wrangler');
      try {
        const remaining = fs.readdirSync(wranglerRoot);
        if (remaining.length === 0) {
          fs.rmdirSync(wranglerRoot);
        }
      } catch {
        // Ignore if .wrangler was already removed.
      }
    }
  });

  it('matches every request golden bodyText, URL, and redaction in workerd and Node', () => {
    assert.equal(workerPayload.profile, ECPAY_B2C_INVOICE_PROFILE);
    assert.deepEqual(workerPayload.paths, ECPAY_B2C_INVOICE_PATHS);

    const expectedById: Record<string, string> = {};
    for (let i = 0; i < B2C_INVOICE_REQUEST_GOLDENS.length; i += 1) {
      const golden = B2C_INVOICE_REQUEST_GOLDENS[i];
      expectedById[golden.id] = golden.bodyText;

      const workerdRow = workerPayload.requests[i];
      const nodeRow = nodePayload.requests[i];
      assert.equal(workerdRow.id, golden.id);
      assert.equal(workerdRow.op, golden.op);
      assert.equal(workerdRow.url, golden.url);
      assert.equal(workerdRow.method, 'POST');
      assert.equal(workerdRow.contentType, 'application/json');
      assert.equal(workerdRow.bodyText, golden.bodyText);
      assert.deepEqual(workerdRow, nodeRow);
    }

    assert.deepEqual(workerPayload.requestBodiesById, expectedById);
  });

  it('matches the lower-hex response golden, all 15 ok response parsers, consent callback, classifiers, and wordTrackRemaining in workerd and Node', () => {
    assert.deepEqual(workerPayload.lowerHexIssueResponse, {
      kind: 'ok',
      value: B2C_INVOICE_ISSUE_RESPONSE_LOWER_HEX.expected,
    });
    assert.equal(workerPayload.consentCallback.kind, 'consent');
    if (workerPayload.consentCallback.kind === 'consent') {
      assert.equal(
        workerPayload.consentCallback.allowanceNo,
        '1909181313013546',
      );
      assert.equal(workerPayload.consentCallback.invoiceNo, 'UV11100019');
      assert.equal(
        workerPayload.consentCallback.allowanceDateTime,
        '2019-09-18 13:13:23',
      );
      assert.equal(
        workerPayload.consentCallback.allowanceAtEpochMs,
        1568783603000,
      );
      assert.equal(workerPayload.consentCallback.remainingAllowanceMinor, 0);
    }
    assert.deepEqual(workerPayload.wordTrackRemainingCases, [
      ['10000010', 39],
      ['10000049', 0],
      [null, null],
      ['09999999', null],
      ['10000050', null],
    ]);
    assert.deepEqual(workerPayload, nodePayload);
  });
});
