import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { Console } from 'node:console';
import { Writable } from 'node:stream';
import { describe, it } from 'node:test';
import util from 'node:util';

import { buildCheckMacSigningInput } from '../../modules/agent-commerce/providers/ecpay/checkmac.js';
import * as ecpayPublic from '../../modules/agent-commerce/providers/ecpay/index.js';
import {
  ECPAY_ACK,
  ECPAY_ORIGINS,
  EcpayKeyPair,
  EcpayProtocolError,
  aesDecryptString,
  aesEncryptString,
  aio,
  computeCheckMacValue,
  decryptData,
  dotnetUrlEncode,
  encodeForm,
  encryptData,
  formUrlDecode,
  invoice,
  isTradeNumber,
  logistics,
  newTradeNumber,
  parseForm,
  parsePipeResponse,
  signFields,
  verifySignedForm,
  type EcpayErrorCode,
} from '../../modules/agent-commerce/providers/ecpay/index.js';
import {
  AES_LOWER_URL_ENCODED,
  AES_UPPER_URL_ENCODED,
  AES_VECTORS,
  AIO_CHECKOUT_2902_INTERMEDIATE,
  ALL_STAGE_KEY_STRINGS,
  CHECKMAC_VECTORS,
  DOTNET_URL_ENCODE_TABLE,
  STAGE_KEYS,
  SYNTHETIC_INVOICE_ROUNDTRIP,
  TRADE_NUMBER_VECTORS,
} from '../worker/ecpay-fixtures/vectors.js';

const collectedErrors: EcpayProtocolError[] = [];
const sensitiveSnippets = new Set<string>([
  ...ALL_STAGE_KEY_STRINGS,
  '促銷方案',
  'Apple iphone 15',
  'D9RMXNrihUYM',
  '合成 買家',
  'A123456789',
  ...AES_VECTORS.map((v) => v.expectedCiphertext),
]);

function expectProtocolError(fn: () => unknown, expectedCode: EcpayErrorCode): EcpayProtocolError {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  assert.ok(
    caught instanceof EcpayProtocolError,
    `Expected EcpayProtocolError(${expectedCode}), got ${String(caught)}`,
  );
  assert.equal(caught.code, expectedCode);
  assert.equal(caught.name, 'EcpayProtocolError');
  assert.equal(caught.cause, undefined);
  collectedErrors.push(caught);
  return caught;
}

describe('ECPay wire-protocol library (Node runtime)', () => {
  it('verifies all official CheckMacValue vectors and service helpers', () => {
    for (const vec of CHECKMAC_VECTORS) {
      const keys = EcpayKeyPair.of(vec.keys.hashKey, vec.keys.hashIV);

      const mac = computeCheckMacValue(vec.fields, keys, vec.algorithm);
      assert.equal(mac, vec.expectedMac, `MAC mismatch for vector ${vec.id}`);

      // Passing fields as a plain Record produces the exact same MAC.
      const macFromRecord = computeCheckMacValue(
        Object.fromEntries(vec.fields),
        keys,
        vec.algorithm,
      );
      assert.equal(macFromRecord, vec.expectedMac);

      // computeCheckMacValue skips an existing CheckMacValue field (case-insensitively).
      const macWithExisting = computeCheckMacValue(
        [...vec.fields, ['checkmacvalue', 'ignored']],
        keys,
        vec.algorithm,
      );
      assert.equal(macWithExisting, vec.expectedMac);

      const signed = signFields(vec.fields, keys, vec.algorithm);
      assert.equal(signed.length, vec.fields.length + 1);
      assert.deepEqual(signed[signed.length - 1], ['CheckMacValue', vec.expectedMac]);

      const wireBody = encodeForm(signed);
      const verified = verifySignedForm(wireBody, keys, vec.algorithm);
      assert.equal(verified.ok, true);
      if (verified.ok) {
        assert.equal(verified.keyIndex, 0);
        assert.deepEqual({ ...verified.fields }, Object.fromEntries(vec.fields));
        assert.equal(Object.prototype.hasOwnProperty.call(verified.fields, 'CheckMacValue'), false);
      }

      // Also verify from Uint8Array wire bytes.
      const verifiedBytes = verifySignedForm(
        new TextEncoder().encode(wireBody),
        keys,
        vec.algorithm,
      );
      assert.equal(verifiedBytes.ok, true);

      // Service-specific helpers:
      if (vec.id === 'invoice-allowance') {
        const allowanceRes = invoice.verifyAllowanceCallback(wireBody, keys);
        assert.equal(allowanceRes.ok, true);
      } else if (vec.algorithm === 'sha256') {
        const aioSigned = aio.sign(vec.fields, keys);
        assert.deepEqual(aioSigned, signed);
        const aioVerified = aio.verify(encodeForm(aioSigned), keys);
        assert.equal(aioVerified.ok, true);
      } else {
        const logiSigned = logistics.sign(vec.fields, keys);
        assert.deepEqual(logiSigned, signed);
        const logiVerified = logistics.verify(encodeForm(logiSigned), keys);
        assert.equal(logiVerified.ok, true);
      }

      // Logistics V5 sample erratum (page 7418): stale doc MAC must fail when V5 fields are present.
      if (vec.staleDocMac) {
        const staleBody = encodeForm([...vec.fields, ['CheckMacValue', vec.staleDocMac]]);
        const staleVerified = logistics.verify(staleBody, keys);
        assert.deepEqual(staleVerified, { ok: false, reason: 'mac_mismatch' });
      }
    }
  });

  it('matches the official 2902 intermediate lower-cased string and does not export internal helpers from index', () => {
    const aioCheckout = CHECKMAC_VECTORS[0];
    assert.equal(aioCheckout.id, 'aio-checkout');
    const keys = EcpayKeyPair.of(aioCheckout.keys.hashKey, aioCheckout.keys.hashIV);

    const signingInput = buildCheckMacSigningInput(aioCheckout.fields, keys);
    assert.equal(signingInput, AIO_CHECKOUT_2902_INTERMEDIATE.urlEncodedLower);
    assert.equal(
      dotnetUrlEncode(AIO_CHECKOUT_2902_INTERMEDIATE.rawJoined).toLowerCase(),
      AIO_CHECKOUT_2902_INTERMEDIATE.urlEncodedLower,
    );

    assert.equal('buildCheckMacSigningInput' in ecpayPublic, false);
    assert.equal('unwrapKeyPair' in ecpayPublic, false);
    assert.equal('unwrapKeyList' in ecpayPublic, false);
  });

  it('matches every row of the .NET URL encoding table (§A)', () => {
    for (const [char, expectedLower] of DOTNET_URL_ENCODE_TABLE) {
      const encoded = dotnetUrlEncode(char);
      assert.equal(
        encoded.toLowerCase(),
        expectedLower,
        `dotnetUrlEncode(${JSON.stringify(char)}) expected ${expectedLower}, got ${encoded}`,
      );
      // Round-trip through formUrlDecode restores the original character.
      assert.equal(formUrlDecode(encoded), char);
    }
  });

  it('demonstrates CheckMacValue letter-case insensitivity and accepts lower-case received MACs', () => {
    const aioReturn = CHECKMAC_VECTORS.find((v) => v.id === 'aio-return')!;
    const keys = EcpayKeyPair.of(aioReturn.keys.hashKey, aioReturn.keys.hashIV);

    // Lower-casing MerchantTradeNo value produces the identical MAC and verifies against the original MAC.
    const lowerTradeNoFields = aioReturn.fields.map(([k, v]) =>
      k === 'MerchantTradeNo' ? ([k, v.toLowerCase()] as const) : ([k, v] as const),
    );
    assert.equal(
      computeCheckMacValue(lowerTradeNoFields, keys, 'sha256'),
      aioReturn.expectedMac,
    );

    const bodyWithLowerTradeNo = encodeForm([
      ...lowerTradeNoFields,
      ['CheckMacValue', aioReturn.expectedMac],
    ]);
    const verifiedLowerValue = aio.verify(bodyWithLowerTradeNo, keys);
    assert.equal(verifiedLowerValue.ok, true);
    if (verifiedLowerValue.ok) {
      assert.equal(verifiedLowerValue.fields.MerchantTradeNo, 'd9rmxnrihuym');
    }

    // Lower-case hex CheckMacValue in wire body is accepted.
    const bodyWithLowerMac = encodeForm([
      ...aioReturn.fields,
      ['CheckMacValue', aioReturn.expectedMac.toLowerCase()],
    ]);
    const verifiedLowerMac = aio.verify(bodyWithLowerMac, keys);
    assert.equal(verifiedLowerMac.ok, true);
  });

  it('distinguishes + versus space in MAC calculation and form decoding', () => {
    const keys = EcpayKeyPair.of(STAGE_KEYS.aio3002607.hashKey, STAGE_KEYS.aio3002607.hashIV);
    const macSpace = computeCheckMacValue({ ItemName: 'A B' }, keys, 'sha256');
    const macPlus = computeCheckMacValue({ ItemName: 'A+B' }, keys, 'sha256');
    assert.notEqual(macSpace, macPlus);

    const parsedPlus = parseForm('ItemName=A%2BB');
    const parsedSpace = parseForm('ItemName=A+B');
    assert.deepEqual(parsedPlus, [['ItemName', 'A+B']]);
    assert.deepEqual(parsedSpace, [['ItemName', 'A B']]);

    // Raw '=' and raw non-ASCII inside value are preserved.
    const parsedRawEq = parseForm('Remark=a=b=c&Msg=交易成功');
    assert.deepEqual(parsedRawEq, [
      ['Remark', 'a=b=c'],
      ['Msg', '交易成功'],
    ]);
  });

  it('rejects tampered, malformed, duplicate, oversized, and invalid-UTF8 forms', () => {
    const aioReturn = CHECKMAC_VECTORS.find((v) => v.id === 'aio-return')!;
    const keys = EcpayKeyPair.of(aioReturn.keys.hashKey, aioReturn.keys.hashIV);
    const wrongKeys = EcpayKeyPair.of(
      STAGE_KEYS.shared2000132.hashKey,
      STAGE_KEYS.shared2000132.hashIV,
    );

    // 1. Tampered value (TradeAmt=403)
    const tamperedFields = aioReturn.fields.map(([k, v]) =>
      k === 'TradeAmt' ? ([k, '403'] as const) : ([k, v] as const),
    );
    const tamperedBody = encodeForm([
      ...tamperedFields,
      ['CheckMacValue', aioReturn.expectedMac],
    ]);
    assert.deepEqual(aio.verify(tamperedBody, keys), { ok: false, reason: 'mac_mismatch' });

    // 2. Removed empty field (CustomField1)
    const withoutEmptyField = aioReturn.fields.filter(([k]) => k !== 'CustomField1');
    const removedFieldBody = encodeForm([
      ...withoutEmptyField,
      ['CheckMacValue', aioReturn.expectedMac],
    ]);
    assert.deepEqual(aio.verify(removedFieldBody, keys), {
      ok: false,
      reason: 'mac_mismatch',
    });

    // 3. Added field
    const addedFieldBody = encodeForm([
      ...aioReturn.fields,
      ['ExtraField', '1'],
      ['CheckMacValue', aioReturn.expectedMac],
    ]);
    assert.deepEqual(aio.verify(addedFieldBody, keys), {
      ok: false,
      reason: 'mac_mismatch',
    });

    // 4. Wrong key
    const validBody = encodeForm([
      ...aioReturn.fields,
      ['CheckMacValue', aioReturn.expectedMac],
    ]);
    assert.deepEqual(aio.verify(validBody, wrongKeys), {
      ok: false,
      reason: 'mac_mismatch',
    });

    // 5. MD5 MAC checked as SHA-256 and vice versa
    const logiCreate = CHECKMAC_VECTORS.find((v) => v.id === 'logistics-create')!;
    const logiKeys = EcpayKeyPair.of(logiCreate.keys.hashKey, logiCreate.keys.hashIV);
    const md5Body = encodeForm([
      ...logiCreate.fields,
      ['CheckMacValue', logiCreate.expectedMac],
    ]);
    // 32-hex MD5 checked as SHA-256 (expects 64 hex) -> missing_mac
    assert.deepEqual(verifySignedForm(md5Body, logiKeys, 'sha256'), {
      ok: false,
      reason: 'missing_mac',
    });
    // 64-hex SHA-256 checked as MD5 (expects 32 hex) -> missing_mac
    assert.deepEqual(verifySignedForm(validBody, keys, 'md5'), {
      ok: false,
      reason: 'missing_mac',
    });

    // 6. MAC wrong length / non-hex / missing / duplicated
    assert.deepEqual(
      aio.verify('RtnCode=1&CheckMacValue=1234', keys),
      { ok: false, reason: 'missing_mac' },
    );
    assert.deepEqual(
      aio.verify(`RtnCode=1&CheckMacValue=${'Z'.repeat(64)}`, keys),
      { ok: false, reason: 'missing_mac' },
    );
    assert.deepEqual(
      aio.verify('RtnCode=1&RtnMsg=ok', keys),
      { ok: false, reason: 'missing_mac' },
    );
    assert.deepEqual(
      aio.verify(
        `RtnCode=1&CheckMacValue=${aioReturn.expectedMac}&checkmacvalue=${aioReturn.expectedMac}`,
        keys,
      ),
      { ok: false, reason: 'duplicate_field' },
    );

    // 7. Duplicate field (case-insensitive)
    expectProtocolError(() => parseForm('RtnCode=1&rtncode=1'), 'duplicate_field');
    assert.deepEqual(aio.verify('RtnCode=1&rtncode=1', keys), {
      ok: false,
      reason: 'duplicate_field',
    });
    expectProtocolError(
      () => encodeForm([['RtnCode', '1'], ['rtncode', '1']]),
      'duplicate_field',
    );
    expectProtocolError(
      () => computeCheckMacValue([['RtnCode', '1'], ['rtncode', '1']], keys, 'sha256'),
      'duplicate_field',
    );

    // 8. Empty form, empty segment, segment without '='
    expectProtocolError(() => parseForm(''), 'empty_form');
    expectProtocolError(() => parseForm(new Uint8Array(0)), 'empty_form');
    expectProtocolError(() => encodeForm([]), 'empty_form');
    expectProtocolError(() => computeCheckMacValue([], keys, 'sha256'), 'empty_form');
    expectProtocolError(
      () => computeCheckMacValue([['CheckMacValue', 'abc']], keys, 'sha256'),
      'empty_form',
    );
    assert.deepEqual(aio.verify('', keys), { ok: false, reason: 'empty_form' });
    assert.deepEqual(
      aio.verify(`CheckMacValue=${aioReturn.expectedMac}`, keys),
      { ok: false, reason: 'empty_form' },
    );

    expectProtocolError(() => parseForm('a=1&&b=2'), 'malformed_form');
    expectProtocolError(() => parseForm('a=1&'), 'malformed_form');
    expectProtocolError(() => parseForm('&a=1'), 'malformed_form');
    expectProtocolError(() => parseForm('a=1&b'), 'malformed_form');
    expectProtocolError(() => parseForm('=1'), 'malformed_form');
    assert.deepEqual(aio.verify('a=1&&b=2', keys), { ok: false, reason: 'malformed_form' });
    assert.deepEqual(aio.verify('a=1&b', keys), { ok: false, reason: 'malformed_form' });

    // 9. Illegal key characters (Rtn-Code, Rtn Code, non-ASCII, >64 chars)
    for (const badKey of ['Rtn-Code', 'Rtn Code', '欄位', 'a'.repeat(65), 'a%20b']) {
      expectProtocolError(() => parseForm(`${badKey}=1`), 'malformed_form');
      assert.deepEqual(aio.verify(`${badKey}=1`, keys), {
        ok: false,
        reason: 'malformed_form',
      });
      expectProtocolError(() => encodeForm([[badKey, '1']]), 'invalid_input');
      expectProtocolError(
        () => computeCheckMacValue([[badKey, '1']], keys, 'sha256'),
        'invalid_input',
      );
    }

    // 10. signFields rejects input that already has CheckMacValue
    expectProtocolError(
      () => signFields([['RtnCode', '1'], ['checkmacvalue', '123']], keys, 'sha256'),
      'invalid_input',
    );

    // 11. Malformed percent escape (%E4%B8, %zz)
    expectProtocolError(() => parseForm('RtnMsg=%E4%B8'), 'malformed_form');
    expectProtocolError(() => parseForm('RtnMsg=%zz'), 'malformed_form');
    expectProtocolError(() => formUrlDecode('%E4%B8'), 'malformed_form');
    expectProtocolError(() => formUrlDecode('%zz'), 'malformed_form');
    assert.deepEqual(aio.verify('RtnMsg=%E4%B8', keys), {
      ok: false,
      reason: 'malformed_form',
    });
    assert.deepEqual(aio.verify('RtnMsg=%zz', keys), {
      ok: false,
      reason: 'malformed_form',
    });

    // 12. Body over 16384 bytes and over 128 fields
    const overBytesBody = `Field=${'a'.repeat(16380)}`;
    expectProtocolError(() => parseForm(overBytesBody), 'form_too_large');
    expectProtocolError(
      () => parseForm(new TextEncoder().encode(overBytesBody)),
      'form_too_large',
    );
    assert.deepEqual(aio.verify(overBytesBody, keys), {
      ok: false,
      reason: 'form_too_large',
    });

    const overFieldsBody = Array.from({ length: 129 }, (_, i) => `k${i}=1`).join('&');
    expectProtocolError(() => parseForm(overFieldsBody), 'form_too_large');
    assert.deepEqual(aio.verify(overFieldsBody, keys), {
      ok: false,
      reason: 'form_too_large',
    });

    // 13. Invalid UTF-8 bytes and lone UTF-16 surrogates
    const invalidUtf8 = new Uint8Array([0x52, 0x74, 0x6e, 0x3d, 0xff, 0xfe]);
    expectProtocolError(() => parseForm(invalidUtf8), 'invalid_text');
    assert.deepEqual(aio.verify(invalidUtf8, keys), {
      ok: false,
      reason: 'invalid_text',
    });

    const loneHighSurrogate = 'hello\uD800world';
    const loneLowSurrogate = 'hello\uDC00world';
    expectProtocolError(() => dotnetUrlEncode(loneHighSurrogate), 'invalid_text');
    expectProtocolError(() => dotnetUrlEncode(loneLowSurrogate), 'invalid_text');
    expectProtocolError(() => parseForm(`A=${loneHighSurrogate}`), 'invalid_text');
    expectProtocolError(
      () => encryptData({ Bad: loneHighSurrogate }, keys),
      'invalid_text',
    );
    expectProtocolError(() => aesEncryptString(loneLowSurrogate, keys), 'invalid_text');
  });

  it('supports key rotation without early exit and rejects empty or invalid key lists', () => {
    const oldKeys = EcpayKeyPair.of(
      STAGE_KEYS.shared2000132.hashKey,
      STAGE_KEYS.shared2000132.hashIV,
    );
    const newKeys = EcpayKeyPair.of(
      STAGE_KEYS.aio3002607.hashKey,
      STAGE_KEYS.aio3002607.hashIV,
    );
    const thirdKeys = EcpayKeyPair.of(
      STAGE_KEYS.logisticsC2c2000933.hashKey,
      STAGE_KEYS.logisticsC2c2000933.hashIV,
    );

    const bodyWithNew = encodeForm(aio.sign({ MerchantID: '3002607', RtnCode: '1' }, newKeys));
    const res1 = aio.verify(bodyWithNew, [oldKeys, newKeys, thirdKeys]);
    assert.equal(res1.ok, true);
    if (res1.ok) {
      assert.equal(res1.keyIndex, 1);
    }

    const bodyWithOld = encodeForm(aio.sign({ MerchantID: '2000132', RtnCode: '1' }, oldKeys));
    const res0 = aio.verify(bodyWithOld, [oldKeys, newKeys, thirdKeys]);
    assert.equal(res0.ok, true);
    if (res0.ok) {
      assert.equal(res0.keyIndex, 0);
    }

    expectProtocolError(() => aio.verify(bodyWithNew, []), 'invalid_key');
    expectProtocolError(
      () => aio.verify(bodyWithNew, [oldKeys, {} as EcpayKeyPair]),
      'invalid_key',
    );
  });

  it('produces null-prototype frozen fields immune to __proto__ and constructor pollution', () => {
    const keys = EcpayKeyPair.of(STAGE_KEYS.aio3002607.hashKey, STAGE_KEYS.aio3002607.hashIV);
    const fields = [
      ['__proto__', 'x'],
      ['constructor', 'y'],
      ['RtnCode', '1'],
    ] as const;
    const signed = aio.sign(fields, keys);
    const wire = encodeForm(signed);
    const verified = aio.verify(wire, keys);

    assert.equal(verified.ok, true);
    if (verified.ok) {
      assert.equal(Object.getPrototypeOf(verified.fields), null);
      assert.equal(Object.isFrozen(verified.fields), true);
      assert.equal(verified.fields['__proto__'], 'x');
      assert.equal(verified.fields['constructor'], 'y');
      assert.equal(verified.fields['RtnCode'], '1');
      assert.equal(({} as Record<string, unknown>).x, undefined);
    }
  });

  it('verifies all official AES vectors, round-trip payload, and AES error codes', () => {
    for (const vec of AES_VECTORS) {
      const keys = EcpayKeyPair.of(vec.keys.hashKey, vec.keys.hashIV);
      assert.equal(aesEncryptString(vec.urlEncodedInput, keys), vec.expectedCiphertext);
      assert.equal(aesDecryptString(vec.expectedCiphertext, keys), vec.urlEncodedInput);
      assert.deepEqual(decryptData(vec.expectedCiphertext, keys), vec.payload);

      if (vec.encodedCase === 'upper') {
        assert.equal(encryptData(vec.payload, keys), vec.expectedCiphertext);
      }
    }

    // Synthetic round trip with Chinese characters, spaces, and .NET special characters:
    const invKeys = EcpayKeyPair.of(
      STAGE_KEYS.invoice2000132.hashKey,
      STAGE_KEYS.invoice2000132.hashIV,
    );
    const rawJson = JSON.stringify(SYNTHETIC_INVOICE_ROUNDTRIP.payload);
    const encodedJson = dotnetUrlEncode(rawJson);
    assert.equal(encodedJson, SYNTHETIC_INVOICE_ROUNDTRIP.expectedUrlEncoded);

    const encrypted = encryptData(SYNTHETIC_INVOICE_ROUNDTRIP.payload, invKeys);
    assert.equal(aesDecryptString(encrypted, invKeys), SYNTHETIC_INVOICE_ROUNDTRIP.expectedUrlEncoded);
    assert.deepEqual(decryptData(encrypted, invKeys), SYNTHETIC_INVOICE_ROUNDTRIP.payload);

    // Wrong key -> decrypt_failed
    const wrongKeys = EcpayKeyPair.of(
      STAGE_KEYS.aio3002607.hashKey,
      STAGE_KEYS.aio3002607.hashIV,
    );
    expectProtocolError(() => aesDecryptString(encrypted, wrongKeys), 'decrypt_failed');

    // Ciphertext with valid length/Base64 that decrypts to invalid UTF-8 -> decrypt_failed
    // Encrypt 16 bytes with one key or tamper the first block so CBC second block becomes random bytes:
    const cipherBuf = Buffer.from(encrypted, 'base64');
    cipherBuf[0] ^= 0xff;
    expectProtocolError(
      () => aesDecryptString(cipherBuf.toString('base64'), invKeys),
      'decrypt_failed',
    );

    // Truncated / garbage / non-multiple-of-16 Base64 -> invalid_base64
    for (const badB64 of [
      '',
      'abc',
      'abcd', // 3 bytes, not a multiple of 16
      Buffer.alloc(15, 1).toString('base64'),
      Buffer.alloc(17, 1).toString('base64'),
      '!!!!' + encrypted.slice(4),
      encrypted.slice(0, -4),
    ]) {
      expectProtocolError(() => aesDecryptString(badB64, invKeys), 'invalid_base64');
    }

    // Plaintext that is not valid URL-encoding -> invalid_encoding
    const badPercentCipher = aesEncryptString('%E4%B8%zz', invKeys);
    expectProtocolError(() => decryptData(badPercentCipher, invKeys), 'invalid_encoding');

    // Plaintext that is valid URL-encoding but not valid JSON -> invalid_json
    const nonJsonCipher = aesEncryptString(dotnetUrlEncode('not-a-json-document'), invKeys);
    expectProtocolError(() => decryptData(nonJsonCipher, invKeys), 'invalid_json');
  });

  it('validates invoice.buildEnvelope and invoice.openResponse across all outcomes', () => {
    const invKeys = EcpayKeyPair.of(
      STAGE_KEYS.invoice2000132.hashKey,
      STAGE_KEYS.invoice2000132.hashIV,
    );
    const otherKeys = EcpayKeyPair.of(
      STAGE_KEYS.aio3002607.hashKey,
      STAGE_KEYS.aio3002607.hashIV,
    );

    const env = invoice.buildEnvelope(
      {
        merchantId: '2000132',
        timestamp: 1700000123,
        payload: { RelateNumber: 'F0000000000000000000', SalesAmount: 100 },
      },
      invKeys,
    );
    assert.equal(env.PlatformID, '');
    assert.equal(env.MerchantID, '2000132');
    assert.deepEqual(env.RqHeader, { Timestamp: 1700000123 });
    assert.deepEqual(decryptData(env.Data, invKeys), {
      RelateNumber: 'F0000000000000000000',
      SalesAmount: 100,
    });

    // Validation errors on buildEnvelope
    expectProtocolError(
      () =>
        invoice.buildEnvelope(
          { merchantId: 'abc', timestamp: 1700000123, payload: {} },
          invKeys,
        ),
      'invalid_input',
    );
    expectProtocolError(
      () =>
        invoice.buildEnvelope(
          { merchantId: '123456', timestamp: 1700000123, payload: {} },
          invKeys,
        ),
      'invalid_input',
    );
    expectProtocolError(
      () =>
        invoice.buildEnvelope(
          { merchantId: '2000132', timestamp: 0, payload: {} },
          invKeys,
        ),
      'invalid_input',
    );
    expectProtocolError(
      () =>
        invoice.buildEnvelope(
          { merchantId: '2000132', timestamp: 1.5, payload: {} },
          invKeys,
        ),
      'invalid_input',
    );

    // 1. Business success (numeric 1 and string "1")
    const okData = encryptData(
      { RtnCode: 1, RtnMsg: '開立發票成功', InvoiceNo: 'UV11100019' },
      invKeys,
    );
    const openedNumeric = invoice.openResponse(
      JSON.stringify({
        PlatformID: '',
        MerchantID: '2000132',
        TransCode: 1,
        TransMsg: '',
        Data: okData,
      }),
      invKeys,
      { merchantId: '2000132' },
    );
    assert.deepEqual(openedNumeric, {
      kind: 'ok',
      data: { RtnCode: 1, RtnMsg: '開立發票成功', InvoiceNo: 'UV11100019' },
    });

    const okStringData = encryptData(
      { RtnCode: '1', RtnMsg: '開立發票成功', InvoiceNo: 'UV11100020' },
      invKeys,
    );
    const openedString = invoice.openResponse(
      JSON.stringify({
        MerchantID: '2000132',
        TransCode: '1',
        TransMsg: 'OK',
        Data: okStringData,
      }),
      invKeys,
      { merchantId: '2000132' },
    );
    assert.deepEqual(openedString, {
      kind: 'ok',
      data: { RtnCode: '1', RtnMsg: '開立發票成功', InvoiceNo: 'UV11100020' },
    });

    // 2. Business rejection (RtnCode != 1) with control char sanitization
    const rejectedData = encryptData(
      { RtnCode: 5000001, RtnMsg: '自訂編號重複\r\n\u0007' },
      invKeys,
    );
    const openedRejected = invoice.openResponse(
      JSON.stringify({
        MerchantID: '2000132',
        TransCode: 1,
        TransMsg: '',
        Data: rejectedData,
      }),
      invKeys,
      { merchantId: '2000132' },
    );
    assert.equal(openedRejected.kind, 'rejected');
    if (openedRejected.kind === 'rejected') {
      assert.equal(openedRejected.rtnCode, '5000001');
      assert.equal(openedRejected.rtnMsg, '自訂編號重複');
    }

    // 3. Transport error (TransCode != 1)
    const openedTransportErr = invoice.openResponse(
      JSON.stringify({
        TransCode: 0,
        TransMsg: 'Timestamp Expired\n',
        Data: '',
      }),
      invKeys,
      { merchantId: '2000132' },
    );
    assert.deepEqual(openedTransportErr, {
      kind: 'transport_error',
      transCode: '0',
      transMsg: 'Timestamp Expired',
    });

    // 4. Merchant mismatch
    assert.deepEqual(
      invoice.openResponse(
        JSON.stringify({
          MerchantID: '3002607',
          TransCode: 1,
          TransMsg: '',
          Data: okData,
        }),
        invKeys,
        { merchantId: '2000132' },
      ),
      { kind: 'invalid', reason: 'merchant_mismatch' },
    );

    // 5. Non-JSON body and array body
    assert.deepEqual(
      invoice.openResponse('<html>502 Bad Gateway</html>', invKeys, {
        merchantId: '2000132',
      }),
      { kind: 'invalid', reason: 'invalid_json' },
    );
    assert.deepEqual(
      invoice.openResponse('[1, 2, 3]', invKeys, { merchantId: '2000132' }),
      { kind: 'invalid', reason: 'not_an_object' },
    );

    // 6. Undecryptable Data, invalid Base64 Data, invalid encoding Data, non-object Data
    assert.deepEqual(
      invoice.openResponse(
        JSON.stringify({ MerchantID: '2000132', TransCode: 1, Data: 'not-base64' }),
        invKeys,
        { merchantId: '2000132' },
      ),
      { kind: 'invalid', reason: 'invalid_base64' },
    );
    assert.deepEqual(
      invoice.openResponse(
        JSON.stringify({ MerchantID: '2000132', TransCode: 1, Data: okData }),
        otherKeys,
        { merchantId: '2000132' },
      ),
      { kind: 'invalid', reason: 'decrypt_failed' },
    );
    assert.deepEqual(
      invoice.openResponse(
        JSON.stringify({
          MerchantID: '2000132',
          TransCode: 1,
          Data: aesEncryptString('%zz', invKeys),
        }),
        invKeys,
        { merchantId: '2000132' },
      ),
      { kind: 'invalid', reason: 'invalid_encoding' },
    );
    assert.deepEqual(
      invoice.openResponse(
        JSON.stringify({
          MerchantID: '2000132',
          TransCode: 1,
          Data: aesEncryptString(dotnetUrlEncode('[1,2,3]'), invKeys),
        }),
        invKeys,
        { merchantId: '2000132' },
      ),
      { kind: 'invalid', reason: 'invalid_payload' },
    );
  });

  it('parses legacy pipe responses and logistics Express/Create responses per EC-SPEC-05 §5.3', () => {
    const logiKeys = EcpayKeyPair.of(
      STAGE_KEYS.logisticsC2c2000933.hashKey,
      STAGE_KEYS.logisticsC2c2000933.hashIV,
    );

    // Signed 1|<form> -> created
    const signedFields = logistics.sign(
      [
        ['AllPayLogisticsID', '1817824'],
        ['BookingNote', ''],
        ['CVSPaymentNo', 'F1234567'],
        ['GoodsAmount', '1000'],
        ['LogisticsSubType', 'FAMIC2C'],
        ['LogisticsType', 'CVS'],
        ['MerchantID', '2000933'],
        ['MerchantTradeNo', 'L000G40R40M30E209185'],
        ['ReceiverName', '合成買家'],
        ['RtnCode', '300'],
        ['RtnMsg', '訂單處理中(已收到訂單資料)'],
      ],
      logiKeys,
    );
    const rawSuccessText = `  1|${encodeForm(signedFields)}\r\n`;
    const createdRes = logistics.parseCreateResponse(rawSuccessText, logiKeys);
    assert.equal(createdRes.kind, 'created');
    if (createdRes.kind === 'created') {
      assert.equal(createdRes.keyIndex, 0);
      assert.equal(createdRes.fields.AllPayLogisticsID, '1817824');
      assert.equal(createdRes.fields.ReceiverName, '合成買家');
    }

    // Tampered 1|<form> -> unknown (mac_mismatch)
    const tamperedText = rawSuccessText.replace('GoodsAmount=1000', 'GoodsAmount=9999');
    assert.deepEqual(logistics.parseCreateResponse(tamperedText, logiKeys), {
      kind: 'unknown',
      reason: 'mac_mismatch',
    });

    // 0|<error message> -> rejected
    const rejectedRes = logistics.parseCreateResponse(
      '0|10500036 收件人姓名請設定為 4~10 字元\r\n',
      logiKeys,
    );
    assert.deepEqual(rejectedRes, {
      kind: 'rejected',
      message: '10500036 收件人姓名請設定為 4~10 字元',
    });

    // 1|OK -> parsePipeResponse is ok, but logistics.parseCreateResponse is unknown
    assert.deepEqual(parsePipeResponse('  1|OK\n'), { kind: 'ok', rest: 'OK' });
    assert.deepEqual(logistics.parseCreateResponse('1|OK', logiKeys), {
      kind: 'unknown',
      reason: 'unexpected_ack',
    });

    // Unparseable inputs: garbage, empty string, missing pipe
    for (const bad of ['garbage', '', '   ', '2|something', '1|']) {
      assert.deepEqual(parsePipeResponse(bad), { kind: 'unparseable' });
      assert.deepEqual(logistics.parseCreateResponse(bad, logiKeys), {
        kind: 'unknown',
        reason: 'unparseable',
      });
    }

    // Error message containing '|' and control characters, and > 200 code points (with astral emoji)
    const msgWithPipeAndCtrl = '0|錯誤代碼\u0000\u0007\r\n|詳細原因|欄位A';
    assert.deepEqual(parsePipeResponse(msgWithPipeAndCtrl), {
      kind: 'error',
      message: '錯誤代碼|詳細原因|欄位A',
    });

    // 205 code points where the 200th code point is a surrogate-pair emoji '📦'
    const longMsg = `${'訊'.repeat(199)}📦${'尾'.repeat(10)}`;
    const parsedLong = parsePipeResponse(`0|${longMsg}`);
    assert.equal(parsedLong.kind, 'error');
    if (parsedLong.kind === 'error') {
      assert.equal(Array.from(parsedLong.message).length, 200);
      assert.equal(parsedLong.message.endsWith('📦'), true);
    }
  });

  it('generates and validates Crockford Base32 trade numbers', () => {
    for (const vec of TRADE_NUMBER_VECTORS) {
      const actual = newTradeNumber(vec.prefix, () => new Uint8Array(vec.bytes));
      assert.equal(actual, vec.expected);
      assert.equal(isTradeNumber(actual), true);
      assert.equal(isTradeNumber(actual, vec.prefix), true);
      assert.equal(isTradeNumber(actual, vec.prefix === 'F' ? 'L' : 'F'), false);
    }

    for (let i = 0; i < 16; i += 1) {
      const generated = newTradeNumber('F');
      assert.equal(generated.length, 20);
      assert.equal(isTradeNumber(generated, 'F'), true);
    }

    // Invalid prefix or randomBytes length -> invalid_input
    for (const badPrefix of ['', 'f', 'FL', '1', '_']) {
      expectProtocolError(() => newTradeNumber(badPrefix), 'invalid_input');
    }
    expectProtocolError(
      () => newTradeNumber('F', () => new Uint8Array(11)),
      'invalid_input',
    );
    expectProtocolError(
      () => newTradeNumber('F', () => new Uint8Array(13)),
      'invalid_input',
    );

    // isTradeNumber rejects I, L, O, U in body and lowercase
    assert.equal(isTradeNumber('F000000000000000000I'), false);
    assert.equal(isTradeNumber('F000000000000000000L'), false);
    assert.equal(isTradeNumber('F000000000000000000O'), false);
    assert.equal(isTradeNumber('F000000000000000000U'), false);
    assert.equal(isTradeNumber('f0000000000000000000'), false);
  });

  it('re-rolls CDN-blocked trade numbers up to 16 attempts and preserves existing trade-number vectors', () => {
    const tftpBytes = [0xd3, 0xf5, 0x60, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const zeroBytes = new Array<number>(12).fill(0);

    let callsOnceThenZero = 0;
    const rerolled = newTradeNumber('L', () => {
      callsOnceThenZero += 1;
      return new Uint8Array(callsOnceThenZero === 1 ? tftpBytes : zeroBytes);
    });
    assert.equal(rerolled, 'L0000000000000000000');
    assert.equal(callsOnceThenZero, 2);

    let callsAlwaysTftp = 0;
    expectProtocolError(
      () =>
        newTradeNumber('L', () => {
          callsAlwaysTftp += 1;
          return new Uint8Array(tftpBytes);
        }),
      'invalid_input',
    );
    assert.equal(callsAlwaysTftp, 16);

    for (const vec of TRADE_NUMBER_VECTORS) {
      let calls = 0;
      const actual = newTradeNumber(vec.prefix, () => {
        calls += 1;
        return new Uint8Array(vec.bytes);
      });
      assert.equal(actual, vec.expected);
      assert.equal(calls, 1);
    }
  });

  it('redacts EcpayKeyPair across all serialization/inspection paths and leaks nothing in errors', () => {
    for (const [badKey, badIV] of [
      ['short', 'EkRm7iFT261dpevs'],
      ['pwFHCqoQZGmho4w6', 'short'],
      ['pwFHCqoQZGmho4w!', 'EkRm7iFT261dpevs'],
      ['pwFHCqoQZGmho4w6', 'EkRm7iFT261dpev_'],
      ['pwFHCqoQZGmho4w67', 'EkRm7iFT261dpevs'],
      ['', ''],
    ]) {
      expectProtocolError(() => EcpayKeyPair.of(badKey, badIV), 'invalid_key');
    }

    const keys = EcpayKeyPair.of(
      STAGE_KEYS.aio3002607.hashKey,
      STAGE_KEYS.aio3002607.hashIV,
    );

    const logChunks: string[] = [];
    const captureStream = new Writable({
      write(chunk, _encoding, callback) {
        logChunks.push(String(chunk));
        callback();
      },
    });
    const testConsole = new Console({ stdout: captureStream, stderr: captureStream });
    testConsole.log(keys);
    testConsole.dir(keys);

    const serializedOutputs = [
      JSON.stringify(keys),
      JSON.stringify({ keys }),
      String(keys),
      `${keys}`,
      util.inspect(keys),
      util.inspect(keys, { showHidden: true, depth: 10 }),
      Object.keys(keys).join(','),
      Object.getOwnPropertyNames(keys).join(','),
      ...logChunks,
    ];

    assert.equal(JSON.stringify(keys), '"[redacted]"');
    assert.equal(String(keys), '[redacted]');
    assert.equal(`${keys}`, '[redacted]');
    assert.equal(util.inspect(keys), 'EcpayKeyPair [redacted]');

    for (const output of serializedOutputs) {
      for (const secret of ALL_STAGE_KEY_STRINGS) {
        assert.equal(
          output.includes(secret),
          false,
          `Key material leaked in output: ${output}`,
        );
      }
    }

    // Verify all 11 error codes were exercised and no collected error message contains any key, plaintext, or ciphertext.
    const seenCodes = new Set(collectedErrors.map((e) => e.code));
    const allCodes: readonly EcpayErrorCode[] = [
      'invalid_key',
      'invalid_text',
      'invalid_input',
      'malformed_form',
      'duplicate_field',
      'form_too_large',
      'empty_form',
      'invalid_base64',
      'decrypt_failed',
      'invalid_encoding',
      'invalid_json',
    ];
    for (const code of allCodes) {
      assert.equal(seenCodes.has(code), true, `Missing test coverage for error code: ${code}`);
    }

    for (const err of collectedErrors) {
      for (const snippet of sensitiveSnippets) {
        assert.equal(
          err.message.includes(snippet),
          false,
          `Error message (${err.code}) leaked sensitive snippet`,
        );
      }
    }

    // Verify ECPAY_ORIGINS and ECPAY_ACK are frozen and match expected URLs.
    assert.equal(ECPAY_ACK, '1|OK');
    assert.equal(Object.isFrozen(ECPAY_ORIGINS), true);
    assert.equal(Object.isFrozen(ECPAY_ORIGINS.payment), true);
    assert.equal(Object.isFrozen(ECPAY_ORIGINS.logistics), true);
    assert.equal(Object.isFrozen(ECPAY_ORIGINS.invoice), true);
  });
});
