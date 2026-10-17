import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

import {
  ECPAY_ACK,
  ECPAY_ORIGINS,
  isTradeNumber,
} from '../../modules/agent-commerce/providers/ecpay/index.js';
import {
  evaluateDeterministicVectors,
  type WorkerProtocolPayload,
} from './ecpay-fixtures/protocol-worker.js';
import {
  AES_VECTORS,
  AIO_CHECKOUT_2902_INTERMEDIATE,
  CHECKMAC_VECTORS,
  DOTNET_URL_ENCODE_TABLE,
  SYNTHETIC_INVOICE_ROUNDTRIP,
  TRADE_NUMBER_VECTORS,
} from './ecpay-fixtures/vectors.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '../..');

describe('ECPay protocol library in workerd (Miniflare)', () => {
  let tempDir: string | undefined;
  let mf: Miniflare | undefined;
  let workerPayload: WorkerProtocolPayload;
  const nodeDeterministic = evaluateDeterministicVectors();

  before(async () => {
    const wranglerRoot = path.join(repoRoot, '.wrangler');
    fs.mkdirSync(wranglerRoot, { recursive: true });
    tempDir = fs.mkdtempSync(path.join(wranglerRoot, 'ecpay-protocol-workerd-'));

    const outfile = path.join(tempDir, 'protocol-worker.mjs');
    await build({
      entryPoints: [path.join(testDir, 'ecpay-fixtures/protocol-worker.ts')],
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
            name: 'protocol-worker',
            modules: true,
            scriptPath: outfile,
            compatibilityDate: '2026-09-21',
            compatibilityFlags: ['nodejs_compat'],
          },
        ],
      }),
    );
    await mf.ready;

    const worker = await mf.getWorker('protocol-worker');
    const response = await worker.fetch('https://ecpay.internal/vectors');
    assert.equal(response.status, 200);
    workerPayload = (await response.json()) as WorkerProtocolPayload;
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

  it('matches every CheckMacValue vector against both expected constants and Node results', () => {
    assert.equal(workerPayload.deterministic.checkMac.length, CHECKMAC_VECTORS.length);
    for (let i = 0; i < CHECKMAC_VECTORS.length; i += 1) {
      const expectedVec = CHECKMAC_VECTORS[i];
      const workerdRow = workerPayload.deterministic.checkMac[i];
      const nodeRow = nodeDeterministic.checkMac[i];

      assert.equal(workerdRow.id, expectedVec.id);
      assert.equal(workerdRow.mac, expectedVec.expectedMac);
      assert.equal(workerdRow.mac, nodeRow.mac);
      assert.equal(workerdRow.encodedBody, nodeRow.encodedBody);
      assert.equal(workerdRow.verifiedOk, true);
      assert.equal(workerdRow.serviceVerifiedOk, true);
      assert.equal(workerdRow.verifiedKeyIndex, 0);
      assert.deepEqual(workerdRow.verifiedFields, Object.fromEntries(expectedVec.fields));
      assert.deepEqual(workerdRow.verifiedFields, nodeRow.verifiedFields);

      if (expectedVec.staleDocMac) {
        assert.equal(workerdRow.staleDocRejected, true);
        assert.equal(nodeRow.staleDocRejected, true);
      }
    }
  });

  it('matches the 2902 intermediate lower-cased URL-encoded string and .NET table in workerd and Node', () => {
    assert.equal(
      workerPayload.deterministic.intermediate2902,
      AIO_CHECKOUT_2902_INTERMEDIATE.urlEncodedLower,
    );
    assert.equal(
      workerPayload.deterministic.intermediate2902,
      nodeDeterministic.intermediate2902,
    );

    assert.equal(
      workerPayload.deterministic.dotnetTable.length,
      DOTNET_URL_ENCODE_TABLE.length,
    );
    for (let i = 0; i < DOTNET_URL_ENCODE_TABLE.length; i += 1) {
      const [rawChar, expectedLower] = DOTNET_URL_ENCODE_TABLE[i];
      const [wChar, wEncoded, wLower] = workerPayload.deterministic.dotnetTable[i];
      const [nChar, nEncoded, nLower] = nodeDeterministic.dotnetTable[i];
      assert.equal(wChar, rawChar);
      assert.equal(nChar, rawChar);
      assert.equal(wLower, expectedLower);
      assert.equal(wEncoded, nEncoded);
      assert.equal(wLower, nLower);
    }
  });

  it('matches every AES-128-CBC vector in workerd and Node', () => {
    assert.equal(workerPayload.deterministic.aes.length, AES_VECTORS.length);
    for (let i = 0; i < AES_VECTORS.length; i += 1) {
      const expectedVec = AES_VECTORS[i];
      const workerdRow = workerPayload.deterministic.aes[i];
      const nodeRow = nodeDeterministic.aes[i];

      assert.equal(workerdRow.id, expectedVec.id);
      assert.equal(workerdRow.encryptedRaw, expectedVec.expectedCiphertext);
      assert.equal(workerdRow.encryptedRaw, nodeRow.encryptedRaw);
      assert.equal(workerdRow.decryptedRaw, expectedVec.urlEncodedInput);
      assert.equal(workerdRow.decryptedRaw, nodeRow.decryptedRaw);
      assert.deepEqual(workerdRow.decryptedData, expectedVec.payload);
      assert.deepEqual(workerdRow.decryptedData, nodeRow.decryptedData);

      if (expectedVec.encodedCase === 'upper') {
        assert.equal(workerdRow.encryptedData, expectedVec.expectedCiphertext);
        assert.equal(workerdRow.encryptedData, nodeRow.encryptedData);
      }
    }
  });

  it('matches every trade-number vector and validates default crypto.getRandomValues in workerd', () => {
    assert.equal(workerPayload.deterministic.tradeNumbers.length, TRADE_NUMBER_VECTORS.length);
    for (let i = 0; i < TRADE_NUMBER_VECTORS.length; i += 1) {
      const expectedVec = TRADE_NUMBER_VECTORS[i];
      const workerdRow = workerPayload.deterministic.tradeNumbers[i];
      const nodeRow = nodeDeterministic.tradeNumbers[i];

      assert.equal(workerdRow.id, expectedVec.id);
      assert.equal(workerdRow.value, expectedVec.expected);
      assert.equal(workerdRow.value, nodeRow.value);
      assert.equal(workerdRow.valid, true);
    }

    assert.equal(workerPayload.defaultRandomTradeNumber.validF, true);
    assert.equal(workerPayload.defaultRandomTradeNumber.validL, false);
    assert.equal(isTradeNumber(workerPayload.defaultRandomTradeNumber.value, 'F'), true);
  });

  it('matches sign/verify and encryptData/decryptData round trips and constants between workerd and Node', () => {
    assert.deepEqual(
      workerPayload.deterministic.signEncodeVerifyRoundTrip,
      nodeDeterministic.signEncodeVerifyRoundTrip,
    );
    assert.equal(
      workerPayload.deterministic.signEncodeVerifyRoundTrip.verified.ok,
      true,
    );
    assert.equal(
      workerPayload.deterministic.signEncodeVerifyRoundTrip.logisticsCreated.kind,
      'created',
    );

    assert.equal(
      workerPayload.deterministic.encryptDecryptRoundTrip.urlEncodedJson,
      SYNTHETIC_INVOICE_ROUNDTRIP.expectedUrlEncoded,
    );
    assert.deepEqual(
      workerPayload.deterministic.encryptDecryptRoundTrip.decrypted,
      SYNTHETIC_INVOICE_ROUNDTRIP.payload,
    );
    assert.deepEqual(
      workerPayload.deterministic.encryptDecryptRoundTrip,
      nodeDeterministic.encryptDecryptRoundTrip,
    );

    assert.equal(workerPayload.deterministic.constants.ack, ECPAY_ACK);
    assert.deepEqual(workerPayload.deterministic.constants.origins, ECPAY_ORIGINS);
    assert.deepEqual(workerPayload.deterministic, nodeDeterministic);
  });
});
