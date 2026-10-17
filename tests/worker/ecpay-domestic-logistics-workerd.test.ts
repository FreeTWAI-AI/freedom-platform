import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

import {
  ECPAY_DOMESTIC_LOGISTICS_PROFILE,
  ECPAY_LOGISTICS_SUBTYPES,
} from '../../modules/agent-commerce/providers/ecpay/domestic-logistics/index.js';
import {
  CANCEL_C2C_GOLDEN_VECTOR,
  CREATE_RESPONSE_GOLDEN_VECTORS,
  CVS_CREATE_ORDER_GOLDEN_VECTORS,
  HOME_CREATE_ORDER_GOLDEN_VECTORS,
  NOTIFICATION_GOLDEN_VECTOR,
  POST_WEIGHT_FORMATTING_VECTORS,
  PRINT_LABEL_GOLDEN_VECTORS,
  QUERY_REQUEST_GOLDEN_VECTORS,
  QUERY_RESPONSE_GOLDEN_VECTOR,
  UPDATE_STORE_GOLDEN_VECTORS,
} from './ecpay-fixtures/domestic-logistics-vectors.js';
import {
  CDN_GUARD_WORKER_VECTORS,
  evaluateDomesticLogisticsVectors,
  type DomesticLogisticsWorkerEvaluation,
} from './ecpay-fixtures/domestic-logistics-worker.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '../..');

describe('ECPay domestic logistics profile (ecpay.logistics.domestic.v1) in workerd (Miniflare)', () => {
  let tempDir: string | undefined;
  let mf: Miniflare | undefined;
  let workerPayload: DomesticLogisticsWorkerEvaluation;
  const nodePayload = evaluateDomesticLogisticsVectors();

  before(async () => {
    const wranglerRoot = path.join(repoRoot, '.wrangler');
    fs.mkdirSync(wranglerRoot, { recursive: true });
    tempDir = fs.mkdtempSync(
      path.join(wranglerRoot, 'ecpay-domestic-logistics-workerd-'),
    );

    const outfile = path.join(tempDir, 'domestic-logistics-worker.mjs');
    await build({
      entryPoints: [
        path.join(testDir, 'ecpay-fixtures/domestic-logistics-worker.ts'),
      ],
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
            name: 'domestic-logistics-worker',
            modules: true,
            scriptPath: outfile,
            compatibilityDate: '2026-09-21',
            compatibilityFlags: ['nodejs_compat'],
          },
        ],
      }),
    );
    await mf.ready;

    const worker = await mf.getWorker('domestic-logistics-worker');
    const response = await worker.fetch(
      'https://ecpay.internal/domestic-logistics',
    );
    assert.equal(response.status, 200);
    workerPayload = (await response.json()) as DomesticLogisticsWorkerEvaluation;
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

  it('matches every CVS and HOME create-order, query, print, cancel, and store-update golden in workerd and Node', () => {
    assert.equal(workerPayload.profile, ECPAY_DOMESTIC_LOGISTICS_PROFILE);
    assert.deepEqual(workerPayload.subTypes, ECPAY_LOGISTICS_SUBTYPES);

    for (let i = 0; i < CVS_CREATE_ORDER_GOLDEN_VECTORS.length; i += 1) {
      const expected = CVS_CREATE_ORDER_GOLDEN_VECTORS[i];
      const workerdRow = workerPayload.cvsCreateGoldens[i];
      const nodeRow = nodePayload.cvsCreateGoldens[i];
      assert.equal(workerdRow.id, expected.id);
      assert.equal(workerdRow.url, expected.expectedUrl);
      assert.equal(workerdRow.mac, expected.expectedCheckMacValue);
      assert.equal(workerdRow.verifiedOk, true);
      assert.deepEqual(workerdRow.fields, expected.expectedFields);
      assert.deepEqual(workerdRow, nodeRow);
    }

    for (let i = 0; i < HOME_CREATE_ORDER_GOLDEN_VECTORS.length; i += 1) {
      const expected = HOME_CREATE_ORDER_GOLDEN_VECTORS[i];
      const workerdRow = workerPayload.homeCreateGoldens[i];
      const nodeRow = nodePayload.homeCreateGoldens[i];
      assert.equal(workerdRow.id, expected.id);
      assert.equal(workerdRow.url, expected.expectedUrl);
      assert.equal(workerdRow.mac, expected.expectedCheckMacValue);
      assert.equal(workerdRow.verifiedOk, true);
      assert.deepEqual(workerdRow.fields, expected.expectedFields);
      assert.deepEqual(workerdRow, nodeRow);
    }

    for (let i = 0; i < QUERY_REQUEST_GOLDEN_VECTORS.length; i += 1) {
      const expected = QUERY_REQUEST_GOLDEN_VECTORS[i];
      const workerdRow = workerPayload.queryRequestGoldens[i];
      const nodeRow = nodePayload.queryRequestGoldens[i];
      assert.equal(workerdRow.id, expected.id);
      assert.equal(workerdRow.url, expected.expectedUrl);
      assert.equal(workerdRow.mac, expected.expectedCheckMacValue);
      assert.equal(workerdRow.verifiedOk, true);
      assert.deepEqual(workerdRow.fields, expected.expectedFields);
      assert.deepEqual(workerdRow, nodeRow);
    }

    for (let i = 0; i < PRINT_LABEL_GOLDEN_VECTORS.length; i += 1) {
      const expected = PRINT_LABEL_GOLDEN_VECTORS[i];
      const workerdRow = workerPayload.printGoldens[i];
      const nodeRow = nodePayload.printGoldens[i];
      assert.equal(workerdRow.id, expected.id);
      assert.equal(workerdRow.action, expected.expectedAction);
      assert.equal(workerdRow.mac, expected.expectedCheckMacValue);
      assert.equal(workerdRow.verifiedOk, true);
      assert.deepEqual(workerdRow.fields, expected.expectedFields);
      assert.deepEqual(workerdRow, nodeRow);
    }

    assert.equal(workerPayload.cancelGolden.id, CANCEL_C2C_GOLDEN_VECTOR.id);
    assert.equal(
      workerPayload.cancelGolden.url,
      CANCEL_C2C_GOLDEN_VECTOR.expectedUrl,
    );
    assert.equal(
      workerPayload.cancelGolden.mac,
      CANCEL_C2C_GOLDEN_VECTOR.expectedCheckMacValue,
    );
    assert.equal(workerPayload.cancelGolden.verifiedOk, true);
    assert.deepEqual(
      workerPayload.cancelGolden.fields,
      CANCEL_C2C_GOLDEN_VECTOR.expectedFields,
    );
    assert.deepEqual(workerPayload.cancelGolden, nodePayload.cancelGolden);

    for (let i = 0; i < UPDATE_STORE_GOLDEN_VECTORS.length; i += 1) {
      const expected = UPDATE_STORE_GOLDEN_VECTORS[i];
      const workerdRow = workerPayload.updateStoreGoldens[i];
      const nodeRow = nodePayload.updateStoreGoldens[i];
      assert.equal(workerdRow.id, expected.id);
      assert.equal(workerdRow.url, expected.expectedUrl);
      assert.equal(workerdRow.mac, expected.expectedCheckMacValue);
      assert.equal(workerdRow.verifiedOk, true);
      assert.deepEqual(workerdRow.fields, expected.expectedFields);
      assert.deepEqual(workerdRow, nodeRow);
    }
  });

  it('matches received-body goldens, official V5 query vector, map return, ACK parser, weight table, and CDN guard in workerd and Node', () => {
    for (let i = 0; i < CREATE_RESPONSE_GOLDEN_VECTORS.length; i += 1) {
      const expected = CREATE_RESPONSE_GOLDEN_VECTORS[i];
      const workerdRow = workerPayload.createResponseGoldens[i];
      assert.equal(workerdRow.id, expected.id);
      assert.equal(workerdRow.signedMac, expected.expectedCheckMacValue);
      assert.deepEqual(workerdRow.result, expected.expectedResult);
    }

    assert.equal(
      workerPayload.notificationGolden.signedMac,
      NOTIFICATION_GOLDEN_VECTOR.expectedCheckMacValue,
    );
    assert.equal(workerPayload.notificationGolden.result.kind, 'notification');
    assert.deepEqual(
      workerPayload.notificationGolden,
      nodePayload.notificationGolden,
    );

    assert.equal(
      workerPayload.queryResponseGolden.signedMac,
      QUERY_RESPONSE_GOLDEN_VECTOR.expectedCheckMacValue,
    );
    assert.deepEqual(
      workerPayload.queryResponseGolden.result,
      QUERY_RESPONSE_GOLDEN_VECTOR.expectedResult,
    );

    assert.equal(workerPayload.officialQueryV5.validMac.kind, 'found');
    assert.deepEqual(workerPayload.officialQueryV5.staleDocMac, {
      kind: 'unknown',
      reason: 'mac_mismatch',
    });

    assert.deepEqual(
      workerPayload.weightFormatting,
      POST_WEIGHT_FORMATTING_VECTORS,
    );
    assert.deepEqual(workerPayload.cdnGuard, CDN_GUARD_WORKER_VECTORS);
    assert.deepEqual(workerPayload, nodePayload);
  });
});
