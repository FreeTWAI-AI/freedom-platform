import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

import { ECPAY_AIO_CREDIT_PROFILE } from '../../modules/agent-commerce/providers/ecpay/aio-credit/index.js';
import {
  CHECKOUT_GOLDEN_VECTORS,
  CREDIT_DETAIL_GOLDEN_VECTOR,
  DO_ACTION_GOLDEN_VECTOR,
  QUERY_GOLDEN_VECTOR,
} from './ecpay-fixtures/aio-credit-vectors.js';
import {
  evaluateAioCreditVectors,
  type AioCreditWorkerEvaluation,
} from './ecpay-fixtures/aio-credit-worker.js';
import { STAGE_KEYS } from './ecpay-fixtures/vectors.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '../..');

describe('ECPay AIO credit profile (ecpay.aio.credit.v1) in workerd (Miniflare)', () => {
  let tempDir: string | undefined;
  let mf: Miniflare | undefined;
  let workerPayload: AioCreditWorkerEvaluation;
  const nodePayload = evaluateAioCreditVectors();

  before(async () => {
    const wranglerRoot = path.join(repoRoot, '.wrangler');
    fs.mkdirSync(wranglerRoot, { recursive: true });
    tempDir = fs.mkdtempSync(path.join(wranglerRoot, 'ecpay-aio-credit-workerd-'));

    const outfile = path.join(tempDir, 'aio-credit-worker.mjs');
    await build({
      entryPoints: [path.join(testDir, 'ecpay-fixtures/aio-credit-worker.ts')],
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
            name: 'aio-credit-worker',
            modules: true,
            scriptPath: outfile,
            compatibilityDate: '2026-09-21',
            compatibilityFlags: ['nodejs_compat'],
          },
        ],
      }),
    );
    await mf.ready;

    const worker = await mf.getWorker('aio-credit-worker');
    const response = await worker.fetch('https://ecpay.internal/aio-credit');
    assert.equal(response.status, 200);
    workerPayload = (await response.json()) as AioCreditWorkerEvaluation;
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

  it('matches every checkout golden vector against both expected constants and Node results', () => {
    assert.equal(workerPayload.profile, ECPAY_AIO_CREDIT_PROFILE);
    assert.equal(workerPayload.checkoutGoldens.length, CHECKOUT_GOLDEN_VECTORS.length);

    for (let i = 0; i < CHECKOUT_GOLDEN_VECTORS.length; i += 1) {
      const expected = CHECKOUT_GOLDEN_VECTORS[i];
      const workerdRow = workerPayload.checkoutGoldens[i];
      const nodeRow = nodePayload.checkoutGoldens[i];

      assert.equal(workerdRow.id, expected.id);
      assert.equal(workerdRow.action, expected.expectedAction);
      assert.equal(workerdRow.mac, expected.expectedCheckMacValue);
      assert.equal(workerdRow.verifiedOk, true);
      assert.deepEqual(workerdRow.fields, expected.expectedFields);
      assert.deepEqual(workerdRow, nodeRow);
    }
  });

  it('matches query, DoAction, and credit-detail goldens and redaction in workerd and Node', () => {
    assert.equal(workerPayload.queryGolden.url, QUERY_GOLDEN_VECTOR.expectedUrl);
    assert.equal(
      workerPayload.queryGolden.mac,
      QUERY_GOLDEN_VECTOR.expectedCheckMacValue,
    );
    assert.equal(workerPayload.queryGolden.verifiedOk, true);
    assert.deepEqual(
      workerPayload.queryGolden.fields,
      QUERY_GOLDEN_VECTOR.expectedFields,
    );
    assert.deepEqual(workerPayload.queryGolden, nodePayload.queryGolden);

    assert.equal(workerPayload.doActionGolden.url, DO_ACTION_GOLDEN_VECTOR.expectedUrl);
    assert.equal(
      workerPayload.doActionGolden.mac,
      DO_ACTION_GOLDEN_VECTOR.expectedCheckMacValue,
    );
    assert.equal(workerPayload.doActionGolden.verifiedOk, true);
    assert.deepEqual(
      workerPayload.doActionGolden.fields,
      DO_ACTION_GOLDEN_VECTOR.expectedFields,
    );
    assert.deepEqual(workerPayload.doActionGolden, nodePayload.doActionGolden);

    assert.equal(
      workerPayload.creditDetailGolden.url,
      CREDIT_DETAIL_GOLDEN_VECTOR.expectedUrl,
    );
    assert.equal(
      workerPayload.creditDetailGolden.mac,
      CREDIT_DETAIL_GOLDEN_VECTOR.expectedCheckMacValue,
    );
    assert.equal(workerPayload.creditDetailGolden.verifiedOk, true);
    assert.deepEqual(
      workerPayload.creditDetailGolden.fields,
      CREDIT_DETAIL_GOLDEN_VECTOR.expectedFields,
    );
    assert.equal(
      JSON.stringify(workerPayload.creditDetailGolden.redactedJson).includes(
        STAGE_KEYS.aio3002607.creditCheckCode,
      ),
      false,
    );
    assert.equal(
      workerPayload.creditDetailGolden.redactedString.includes(
        STAGE_KEYS.aio3002607.creditCheckCode,
      ),
      false,
    );
    assert.equal(workerPayload.creditDetailGolden.checkCodeJson, '"[redacted]"');
    assert.equal(workerPayload.creditDetailGolden.checkCodeString, '[redacted]');
    assert.deepEqual(workerPayload.creditDetailGolden, nodePayload.creditDetailGolden);
  });

  it('matches notifications, browser return, and card-data exclusion in workerd and Node', () => {
    assert.equal(workerPayload.notifications.official2878.kind, 'notification');
    if (workerPayload.notifications.official2878.kind === 'notification') {
      assert.equal(workerPayload.notifications.official2878.outcome, 'paid');
      assert.equal(
        workerPayload.notifications.official2878.merchantTradeNo,
        'D9RMXNRIHUYM',
      );
      assert.equal(workerPayload.notifications.official2878.tradeAmtMinor, 40200);
      assert.equal(workerPayload.notifications.official2878.chargeFeeMinor, 1000);
      assert.equal(workerPayload.notifications.official2878.gwsr, null);
    }

    assert.equal(
      workerPayload.notifications.official2878LowerTradeNo.kind,
      'notification',
    );
    if (
      workerPayload.notifications.official2878.kind === 'notification' &&
      workerPayload.notifications.official2878LowerTradeNo.kind === 'notification'
    ) {
      assert.deepEqual(
        workerPayload.notifications.official2878LowerTradeNo.dedupe,
        workerPayload.notifications.official2878.dedupe,
      );
    }

    assert.equal(workerPayload.notifications.syntheticExtras.kind, 'notification');
    if (workerPayload.notifications.syntheticExtras.kind === 'notification') {
      assert.equal(workerPayload.notifications.syntheticExtras.gwsr, '11943021');
      const serialized = JSON.stringify(workerPayload.notifications.syntheticExtras);
      assert.equal(serialized.includes('777777'), false);
      assert.equal(serialized.includes('9876'), false);
      assert.equal(serialized.includes('431195'), false);
    }

    assert.deepEqual(workerPayload.notifications.browserReturn2878, {
      kind: 'return',
      merchantTradeNo: 'D9RMXNRIHUYM',
      keyIndex: 0,
    });
    assert.deepEqual(workerPayload.notifications, nodePayload.notifications);
  });

  it('matches query responses, credit-detail responses, refund table, DoAction responses, and time helpers', () => {
    assert.deepEqual(workerPayload.availability, nodePayload.availability);
    assert.deepEqual(workerPayload.queryResponses, nodePayload.queryResponses);
    assert.deepEqual(
      workerPayload.creditDetailResponses,
      nodePayload.creditDetailResponses,
    );
    assert.deepEqual(workerPayload.refundTable, nodePayload.refundTable);
    assert.deepEqual(workerPayload.doActionResponses, nodePayload.doActionResponses);
    assert.deepEqual(workerPayload.timeHelpers, nodePayload.timeHelpers);
    assert.deepEqual(workerPayload, nodePayload);
  });
});
