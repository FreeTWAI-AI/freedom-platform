import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import util from 'node:util';

import {
  ECPAY_DOMESTIC_LOGISTICS_PROFILE,
  ECPAY_LOGISTICS_SUBTYPES,
  EcpayBrowserForm,
  EcpayServerRequest,
  buildCancelC2COrderRequest,
  buildCvsCreateOrderRequest,
  buildCvsMapForm,
  buildHomeCreateOrderRequest,
  buildLogisticsQueryRequest,
  buildPrintLabelForm,
  buildUpdateStoreRequest,
  parseCreateOrderResponse,
  parseCvsMapReturn,
  parseLogisticsAckResponse,
  parseLogisticsNotification,
  parseLogisticsQueryResponse,
  subTypeForServiceKey,
  type CvsCreateOrderInput,
  type HomeCreateOrderInput,
} from '../../modules/agent-commerce/providers/ecpay/domestic-logistics/index.js';
import {
  EcpayKeyPair,
  EcpayProtocolError,
  dotnetUrlEncode,
  encodeForm,
  findCdnBlockedTerm,
  logistics,
  parseForm,
  type EcpayErrorCode,
  type FormFields,
} from '../../modules/agent-commerce/providers/ecpay/index.js';
import {
  CANCEL_C2C_GOLDEN_VECTOR,
  CREATE_RESPONSE_GOLDEN_VECTORS,
  CVS_CREATE_ORDER_GOLDEN_VECTORS,
  DOMESTIC_LOGISTICS_CREATED_AT_EPOCH_MS,
  DOMESTIC_LOGISTICS_CVS_RECEIVER_BASE,
  DOMESTIC_LOGISTICS_CVS_SENDER,
  DOMESTIC_LOGISTICS_GOODS_AMOUNT_MINOR,
  DOMESTIC_LOGISTICS_HOME_RECEIVER,
  DOMESTIC_LOGISTICS_HOME_SENDER,
  DOMESTIC_LOGISTICS_SANDBOX_ORIGIN,
  DOMESTIC_LOGISTICS_SERVER_REPLY_URL,
  DOMESTIC_LOGISTICS_TIMESTAMP_SECONDS,
  HOME_CREATE_ORDER_GOLDEN_VECTORS,
  NOTIFICATION_GOLDEN_VECTOR,
  POST_WEIGHT_FORMATTING_VECTORS,
  PRINT_LABEL_GOLDEN_VECTORS,
  QUERY_REQUEST_GOLDEN_VECTORS,
  QUERY_RESPONSE_GOLDEN_VECTOR,
  UPDATE_STORE_GOLDEN_VECTORS,
} from '../worker/ecpay-fixtures/domestic-logistics-vectors.js';
import {
  ALL_STAGE_KEY_STRINGS,
  CHECKMAC_VECTORS,
  STAGE_KEYS,
} from '../worker/ecpay-fixtures/vectors.js';

const c2cKeys = EcpayKeyPair.of(
  STAGE_KEYS.logisticsC2c2000933.hashKey,
  STAGE_KEYS.logisticsC2c2000933.hashIV,
);
const homeKeys = EcpayKeyPair.of(
  STAGE_KEYS.shared2000132.hashKey,
  STAGE_KEYS.shared2000132.hashIV,
);

const NEVER_SENT_CREATE_FIELDS = [
  'ReceiverEmail',
  'ReceiverPhone',
  'SenderPhone',
  'Remark',
  'ReturnStoreID',
  'CollectionAmount',
  'ClientReplyURL',
  'LogisticsC2CReplyURL',
  'PlatformID',
] as const;

describe('ECPay domestic logistics profile (ecpay.logistics.domestic.v1)', () => {
  const capturedErrors: EcpayProtocolError[] = [];

  function expectProtocolError(fn: () => unknown, expectedCode: EcpayErrorCode): void {
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
    capturedErrors.push(caught);
  }

  function replaceOrRemoveField(
    fields: FormFields,
    key: string,
    nextValue: string | null,
  ): FormFields {
    const out: Array<readonly [string, string]> = [];
    for (const [k, v] of fields) {
      if (k === key) {
        if (nextValue !== null) {
          out.push([k, nextValue]);
        }
      } else {
        out.push([k, v]);
      }
    }
    return out;
  }

  it('proves every request golden vector (CVS/HOME create, query, print, cancel, store update) and map form', () => {
    for (const vec of CVS_CREATE_ORDER_GOLDEN_VECTORS) {
      const req = buildCvsCreateOrderRequest(vec.input, c2cKeys);
      assert.equal(req.method, 'POST');
      assert.equal(req.url, vec.expectedUrl);
      assert.equal(req.contentType, 'application/x-www-form-urlencoded');

      const body = req.bodyText();
      const parsed = parseForm(body);
      assert.deepEqual(parsed, vec.expectedFields);
      assert.equal(parsed[parsed.length - 1][1], vec.expectedCheckMacValue);

      const verified = logistics.verify(body, c2cKeys);
      assert.equal(verified.ok, true);

      const fieldNames = new Set(parsed.map(([k]) => k));
      for (const forbidden of NEVER_SENT_CREATE_FIELDS) {
        assert.equal(fieldNames.has(forbidden), false, `Unexpected field ${forbidden}`);
      }
    }

    for (const vec of HOME_CREATE_ORDER_GOLDEN_VECTORS) {
      const req = buildHomeCreateOrderRequest(vec.input, homeKeys);
      assert.equal(req.method, 'POST');
      assert.equal(req.url, vec.expectedUrl);
      assert.equal(req.contentType, 'application/x-www-form-urlencoded');

      const body = req.bodyText();
      const parsed = parseForm(body);
      assert.deepEqual(parsed, vec.expectedFields);
      assert.equal(parsed[parsed.length - 1][1], vec.expectedCheckMacValue);

      const verified = logistics.verify(body, homeKeys);
      assert.equal(verified.ok, true);

      const fieldNames = new Set(parsed.map(([k]) => k));
      for (const forbidden of [...NEVER_SENT_CREATE_FIELDS, 'ReceiverStoreID']) {
        assert.equal(fieldNames.has(forbidden), false, `Unexpected field ${forbidden}`);
      }
      if (vec.id === 'create-post') {
        for (const postForbidden of [
          'IsCollection',
          'Distance',
          'Specification',
          'ScheduledPickupTime',
          'ScheduledDeliveryTime',
        ]) {
          assert.equal(fieldNames.has(postForbidden), false);
        }
      }
    }

    for (const vec of QUERY_REQUEST_GOLDEN_VECTORS) {
      const keys = EcpayKeyPair.of(vec.keys.hashKey, vec.keys.hashIV);
      const req = buildLogisticsQueryRequest(vec.input, keys);
      assert.equal(req.url, vec.expectedUrl);
      const body = req.bodyText();
      const parsed = parseForm(body);
      assert.deepEqual(parsed, vec.expectedFields);
      assert.equal(parsed[parsed.length - 1][1], vec.expectedCheckMacValue);
      assert.equal(logistics.verify(body, keys).ok, true);
    }

    for (const vec of PRINT_LABEL_GOLDEN_VECTORS) {
      const keys = EcpayKeyPair.of(vec.keys.hashKey, vec.keys.hashIV);
      const form = buildPrintLabelForm(vec.input, keys);
      assert.equal(form.method, 'POST');
      assert.equal(form.action, vec.expectedAction);
      const fields = form.fields();
      assert.deepEqual(fields, vec.expectedFields);
      assert.equal(fields[fields.length - 1][1], vec.expectedCheckMacValue);
      assert.equal(logistics.verify(encodeForm(fields), keys).ok, true);
    }

    const cancelReq = buildCancelC2COrderRequest(
      CANCEL_C2C_GOLDEN_VECTOR.input,
      c2cKeys,
    );
    assert.equal(cancelReq.url, CANCEL_C2C_GOLDEN_VECTOR.expectedUrl);
    const cancelParsed = parseForm(cancelReq.bodyText());
    assert.deepEqual(cancelParsed, CANCEL_C2C_GOLDEN_VECTOR.expectedFields);
    assert.equal(
      cancelParsed[cancelParsed.length - 1][1],
      CANCEL_C2C_GOLDEN_VECTOR.expectedCheckMacValue,
    );
    assert.equal(logistics.verify(cancelReq.bodyText(), c2cKeys).ok, true);

    for (const vec of UPDATE_STORE_GOLDEN_VECTORS) {
      const req = buildUpdateStoreRequest(vec.input, c2cKeys);
      assert.equal(req.url, vec.expectedUrl);
      const parsed = parseForm(req.bodyText());
      assert.deepEqual(parsed, vec.expectedFields);
      assert.equal(parsed[parsed.length - 1][1], vec.expectedCheckMacValue);
      assert.equal(logistics.verify(req.bodyText(), c2cKeys).ok, true);
    }

    const mapForm = buildCvsMapForm({
      environment: 'sandbox',
      merchantId: STAGE_KEYS.logisticsC2c2000933.merchantId,
      subType: 'UNIMARTC2C',
      serverReplyUrl: DOMESTIC_LOGISTICS_SERVER_REPLY_URL,
      extraData: 'A1b2C3d4E5f6G7h8J9k0',
      device: 'desktop',
    });
    assert.equal(mapForm.method, 'POST');
    assert.equal(
      mapForm.action,
      `${DOMESTIC_LOGISTICS_SANDBOX_ORIGIN}/Express/map`,
    );
    const mapFields = mapForm.fields();
    assert.deepEqual(mapFields, [
      ['MerchantID', '2000933'],
      ['LogisticsType', 'CVS'],
      ['LogisticsSubType', 'UNIMARTC2C'],
      ['IsCollection', 'N'],
      ['ServerReplyURL', DOMESTIC_LOGISTICS_SERVER_REPLY_URL],
      ['ExtraData', 'A1b2C3d4E5f6G7h8J9k0'],
      ['Device', '0'],
    ]);
    const mapFieldKeys = new Set(mapFields.map(([k]) => k));
    assert.equal(mapFieldKeys.has('CheckMacValue'), false);
    assert.equal(mapFieldKeys.has('MerchantTradeNo'), false);
  });

  it('enforces POST weight formatting and HOME subtype-specific parameter rules', () => {
    const postBase = HOME_CREATE_ORDER_GOLDEN_VECTORS.find(
      (v) => v.id === 'create-post',
    )!.input;
    const tcatBase = HOME_CREATE_ORDER_GOLDEN_VECTORS.find(
      (v) => v.id === 'create-tcat',
    )!.input;

    for (const [grams, expectedKg] of POST_WEIGHT_FORMATTING_VECTORS) {
      const req = buildHomeCreateOrderRequest(
        { ...postBase, weightGrams: grams },
        homeKeys,
      );
      const fields = Object.fromEntries(parseForm(req.bodyText()));
      assert.equal(fields.GoodsWeight, expectedKg);
      assert.equal(logistics.verify(req.bodyText(), homeKeys).ok, true);
    }

    for (const [distance, expectedDistanceCode] of [
      ['same_county', '00'],
      ['other_county', '01'],
      ['outlying', '02'],
    ] as const) {
      const req = buildHomeCreateOrderRequest({ ...tcatBase, distance }, homeKeys);
      const fields = Object.fromEntries(parseForm(req.bodyText()));
      assert.equal(fields.Distance, expectedDistanceCode);
    }

    for (const [sizeCm, expectedSpecCode] of [
      [60, '0001'],
      [90, '0002'],
      [120, '0003'],
      [150, '0004'],
    ] as const) {
      const req = buildHomeCreateOrderRequest({ ...tcatBase, sizeCm }, homeKeys);
      const fields = Object.fromEntries(parseForm(req.bodyText()));
      assert.equal(fields.Specification, expectedSpecCode);
    }

    for (const badWeight of [0, -1, 20001, 1.5, Number.NaN, undefined]) {
      expectProtocolError(
        () =>
          buildHomeCreateOrderRequest(
            { ...postBase, weightGrams: badWeight as number },
            homeKeys,
          ),
        'invalid_input',
      );
    }

    expectProtocolError(
      () =>
        buildHomeCreateOrderRequest(
          { ...tcatBase, weightGrams: 1500 },
          homeKeys,
        ),
      'invalid_input',
    );
    expectProtocolError(
      () =>
        buildHomeCreateOrderRequest(
          { ...postBase, distance: 'same_county' },
          homeKeys,
        ),
      'invalid_input',
    );
    expectProtocolError(
      () =>
        buildHomeCreateOrderRequest({ ...postBase, sizeCm: 60 }, homeKeys),
      'invalid_input',
    );
    expectProtocolError(
      () =>
        buildHomeCreateOrderRequest(
          { ...tcatBase, distance: undefined },
          homeKeys,
        ),
      'invalid_input',
    );
    expectProtocolError(
      () =>
        buildHomeCreateOrderRequest({ ...tcatBase, sizeCm: undefined }, homeKeys),
      'invalid_input',
    );
    expectProtocolError(
      () =>
        buildHomeCreateOrderRequest(
          { ...tcatBase, sizeCm: 100 as unknown as 60 },
          homeKeys,
        ),
      'invalid_input',
    );
  });

  it('enforces party rules, subtype constraints, goods amounts, trade numbers, timestamps, and URLs', () => {
    const cvsBase: CvsCreateOrderInput = CVS_CREATE_ORDER_GOLDEN_VECTORS[0].input;
    const homeBase: HomeCreateOrderInput = HOME_CREATE_ORDER_GOLDEN_VECTORS[0].input;

    for (const badName of ['Amy', '合成買家合成買', '王1明', '王 明', 'Echo', 'ECHO', '']) {
      expectProtocolError(
        () =>
          buildCvsCreateOrderRequest(
            {
              ...cvsBase,
              receiver: { ...cvsBase.receiver, name: badName },
            },
            c2cKeys,
          ),
        'invalid_input',
      );
      expectProtocolError(
        () =>
          buildHomeCreateOrderRequest(
            {
              ...homeBase,
              sender: { ...homeBase.sender, name: badName },
            },
            homeKeys,
          ),
        'invalid_input',
      );
    }

    for (const badPhone of ['0912-345678', '+886912345678', '091234567', '0812345678', '09123456789']) {
      expectProtocolError(
        () =>
          buildCvsCreateOrderRequest(
            {
              ...cvsBase,
              receiver: { ...cvsBase.receiver, cellPhone: badPhone },
            },
            c2cKeys,
          ),
        'invalid_input',
      );
    }

    for (const validZip of ['100', '10048', '100001']) {
      const req = buildHomeCreateOrderRequest(
        {
          ...homeBase,
          receiver: { ...homeBase.receiver, zipCode: validZip },
        },
        homeKeys,
      );
      assert.equal(logistics.verify(req.bodyText(), homeKeys).ok, true);
    }

    for (const badZip of ['1234', '1234567', '10a', '']) {
      expectProtocolError(
        () =>
          buildHomeCreateOrderRequest(
            {
              ...homeBase,
              receiver: { ...homeBase.receiver, zipCode: badZip },
            },
            homeKeys,
          ),
        'invalid_input',
      );
    }

    const addr7 = '臺北合成路1號';
    const addr60 = `臺北市中正區合成路${'1'.repeat(51)}`;
    assert.equal(Array.from(addr7).length, 7);
    assert.equal(Array.from(addr60).length, 60);
    for (const validAddr of [addr7, addr60]) {
      const req = buildHomeCreateOrderRequest(
        {
          ...homeBase,
          receiver: { ...homeBase.receiver, address: validAddr },
        },
        homeKeys,
      );
      assert.equal(logistics.verify(req.bodyText(), homeKeys).ok, true);
    }

    const addr6 = '臺北合成1號';
    const addr61 = `臺北市中正區合成路${'1'.repeat(52)}`;
    assert.equal(Array.from(addr6).length, 6);
    assert.equal(Array.from(addr61).length, 61);
    for (const badAddr of [
      addr6,
      addr61,
      '臺北市<中正區>1號',
      '臺北市&中正區1號',
      '臺北市\u0007中正區1號',
      '臺北市\u0085中正區1號',
      '臺北市\uD800中正區1號',
      ' 臺北市中正區合成路1號',
      '臺北市中正區合成路1號 ',
      '臺北市中正區 echo 路1號',
      '臺北市中正區;合成路1號',
    ]) {
      expectProtocolError(
        () =>
          buildHomeCreateOrderRequest(
            {
              ...homeBase,
              receiver: { ...homeBase.receiver, address: badAddr },
            },
            homeKeys,
          ),
        'invalid_input',
      );
    }

    for (const badStoreId of ['1234567', '13-386', '']) {
      expectProtocolError(
        () =>
          buildCvsCreateOrderRequest(
            {
              ...cvsBase,
              receiver: { ...cvsBase.receiver, storeId: badStoreId },
            },
            c2cKeys,
          ),
        'invalid_input',
      );
    }

    expectProtocolError(
      () =>
        buildCvsCreateOrderRequest(
          { ...cvsBase, subType: 'TCAT' as unknown as 'UNIMARTC2C' },
          c2cKeys,
        ),
      'invalid_input',
    );
    expectProtocolError(
      () =>
        buildHomeCreateOrderRequest(
          { ...homeBase, subType: 'UNIMARTC2C' as unknown as 'TCAT' },
          homeKeys,
        ),
      'invalid_input',
    );

    for (const badAmount of [0, 50, -100, 2000100]) {
      expectProtocolError(
        () =>
          buildCvsCreateOrderRequest(
            { ...cvsBase, goodsAmountMinor: badAmount },
            c2cKeys,
          ),
        'invalid_input',
      );
    }
    const home20001Req = buildHomeCreateOrderRequest(
      { ...homeBase, goodsAmountMinor: 2000100 },
      homeKeys,
    );
    assert.equal(
      Object.fromEntries(parseForm(home20001Req.bodyText())).GoodsAmount,
      '20001',
    );

    for (const badTradeNo of [
      'F7K3QPZ2610150902AB1',
      'l7k3qpz2610150902ab1',
      'LTFTP000000000000000',
    ]) {
      expectProtocolError(
        () =>
          buildCvsCreateOrderRequest(
            { ...cvsBase, merchantTradeNo: badTradeNo },
            c2cKeys,
          ),
        'invalid_input',
      );
    }

    expectProtocolError(
      () =>
        buildCvsCreateOrderRequest(
          { ...cvsBase, environment: 'staging' as unknown as 'sandbox' },
          c2cKeys,
        ),
      'invalid_input',
    );
    expectProtocolError(
      () =>
        buildCvsCreateOrderRequest(
          { ...cvsBase, createdAtEpochMs: -1 },
          c2cKeys,
        ),
      'invalid_input',
    );

    for (const badUrl of [
      'http://freedom.example.com/cb',
      'https://freedom.example.com/cb?a=1',
      'https://freedom.example.com/cb?',
      'https://freedom.example.com/cb#frag',
      'https://freedom.example.com/%41',
      'https://freedom.example.com/a;b',
      'https://freedom.example.com/a|b',
      'https://freedom.example.com/abcd/x',
      'https://echo.example.com/cb',
    ]) {
      expectProtocolError(
        () =>
          buildCvsCreateOrderRequest(
            { ...cvsBase, serverReplyUrl: badUrl },
            c2cKeys,
          ),
        'invalid_input',
      );
    }
  });

  it('parses create-order responses with strict verification, lenient optional fields, and no PII leakage', () => {
    for (const vec of CREATE_RESPONSE_GOLDEN_VECTORS) {
      const keys = EcpayKeyPair.of(vec.keys.hashKey, vec.keys.hashIV);
      const signed = logistics.sign(vec.unsignedFields, keys);
      assert.equal(signed[signed.length - 1][1], vec.expectedCheckMacValue);

      const text = `1|${encodeForm(signed)}`;
      const result = parseCreateOrderResponse(text, keys, vec.options);
      assert.deepEqual(result, vec.expectedResult);
      assert.equal(Object.isFrozen(result), true);
      if (result.kind === 'created') {
        assert.equal(Object.isFrozen(result.ignoredFields), true);
      }

      const serialized = JSON.stringify(result);
      assert.equal(serialized.includes('合成買家'), false);
      assert.equal(serialized.includes('0987654321'), false);
      assert.equal(serialized.includes('高雄市'), false);

      const lowerTradeNoFields = replaceOrRemoveField(
        vec.unsignedFields,
        'MerchantTradeNo',
        vec.options.merchantTradeNo.toLowerCase(),
      );
      const lowerSigned = logistics.sign(lowerTradeNoFields, keys);
      const lowerResult = parseCreateOrderResponse(
        `1|${encodeForm(lowerSigned)}`,
        keys,
        vec.options,
      );
      assert.deepEqual(lowerResult, vec.expectedResult);
    }

    const unimartVec = CREATE_RESPONSE_GOLDEN_VECTORS[0];

    assert.deepEqual(
      parseCreateOrderResponse('0|10500036 ReceiverName 長度錯誤', c2cKeys, unimartVec.options),
      {
        kind: 'rejected',
        message: '10500036 ReceiverName 長度錯誤',
      },
    );
    assert.deepEqual(
      parseCreateOrderResponse('0|找不到加密金鑰', c2cKeys, unimartVec.options),
      {
        kind: 'rejected',
        message: '找不到加密金鑰',
      },
    );
    assert.deepEqual(
      parseCreateOrderResponse('1|OK', c2cKeys, unimartVec.options),
      {
        kind: 'unknown',
        reason: 'unexpected_ack',
      },
    );
    assert.deepEqual(
      parseCreateOrderResponse('<html>502</html>', c2cKeys, unimartVec.options),
      {
        kind: 'unknown',
        reason: 'unparseable',
      },
    );
    assert.deepEqual(
      parseCreateOrderResponse('', c2cKeys, unimartVec.options),
      {
        kind: 'unknown',
        reason: 'unparseable',
      },
    );

    const validSigned = logistics.sign(unimartVec.unsignedFields, c2cKeys);
    const tamperedFields = validSigned.map(([k, v]) =>
      k === 'GoodsAmount' ? ([k, '999'] as const) : ([k, v] as const),
    );
    assert.deepEqual(
      parseCreateOrderResponse(`1|${encodeForm(tamperedFields)}`, c2cKeys, unimartVec.options),
      {
        kind: 'unknown',
        reason: 'mac_mismatch',
      },
    );

    const signVariant = (fields: FormFields): string =>
      `1|${encodeForm(logistics.sign(fields, c2cKeys))}`;

    assert.deepEqual(
      parseCreateOrderResponse(
        signVariant(replaceOrRemoveField(unimartVec.unsignedFields, 'MerchantID', '2000132')),
        c2cKeys,
        unimartVec.options,
      ),
      { kind: 'unknown', reason: 'merchant_mismatch' },
    );
    assert.deepEqual(
      parseCreateOrderResponse(
        signVariant(
          replaceOrRemoveField(
            unimartVec.unsignedFields,
            'MerchantTradeNo',
            'L7K3QPZ2610150902ZZZ',
          ),
        ),
        c2cKeys,
        unimartVec.options,
      ),
      { kind: 'unknown', reason: 'merchant_trade_no_mismatch' },
    );
    assert.deepEqual(
      parseCreateOrderResponse(
        signVariant(replaceOrRemoveField(unimartVec.unsignedFields, 'LogisticsType', 'HOME')),
        c2cKeys,
        unimartVec.options,
      ),
      { kind: 'unknown', reason: 'subtype_mismatch' },
    );
    assert.deepEqual(
      parseCreateOrderResponse(
        signVariant(
          replaceOrRemoveField(unimartVec.unsignedFields, 'LogisticsSubType', 'FAMIC2C'),
        ),
        c2cKeys,
        unimartVec.options,
      ),
      { kind: 'unknown', reason: 'subtype_mismatch' },
    );
    assert.deepEqual(
      parseCreateOrderResponse(
        signVariant(replaceOrRemoveField(unimartVec.unsignedFields, 'GoodsAmount', '1400')),
        c2cKeys,
        unimartVec.options,
      ),
      { kind: 'unknown', reason: 'amount_mismatch' },
    );

    for (const requiredField of [
      'MerchantID',
      'MerchantTradeNo',
      'AllPayLogisticsID',
      'LogisticsType',
      'LogisticsSubType',
      'GoodsAmount',
      'RtnCode',
    ]) {
      assert.deepEqual(
        parseCreateOrderResponse(
          signVariant(replaceOrRemoveField(unimartVec.unsignedFields, requiredField, '')),
          c2cKeys,
          unimartVec.options,
        ),
        { kind: 'unknown', reason: 'missing_field', field: requiredField },
      );
    }

    for (const [invalidField, badVal] of [
      ['MerchantTradeNo', 'BAD-TRADE-NO'],
      ['AllPayLogisticsID', 'ABC123'],
      ['GoodsAmount', '1500.5'],
      ['RtnCode', '300A'],
    ] as const) {
      assert.deepEqual(
        parseCreateOrderResponse(
          signVariant(replaceOrRemoveField(unimartVec.unsignedFields, invalidField, badVal)),
          c2cKeys,
          unimartVec.options,
        ),
        { kind: 'unknown', reason: 'invalid_field', field: invalidField },
      );
    }

    const emptyPaymentNoResult = parseCreateOrderResponse(
      signVariant(replaceOrRemoveField(unimartVec.unsignedFields, 'CVSPaymentNo', '')),
      c2cKeys,
      unimartVec.options,
    );
    assert.equal(emptyPaymentNoResult.kind, 'created');
    if (emptyPaymentNoResult.kind === 'created') {
      assert.equal(emptyPaymentNoResult.cvsPaymentNo, null);
      assert.deepEqual(emptyPaymentNoResult.ignoredFields, []);
    }

    const badBookingNoteResult = parseCreateOrderResponse(
      signVariant(replaceOrRemoveField(unimartVec.unsignedFields, 'BookingNote', '<b>')),
      c2cKeys,
      unimartVec.options,
    );
    assert.equal(badBookingNoteResult.kind, 'created');
    if (badBookingNoteResult.kind === 'created') {
      assert.equal(badBookingNoteResult.bookingNote, null);
      assert.deepEqual(badBookingNoteResult.ignoredFields, ['BookingNote']);
    }

    const rotatedResult = parseCreateOrderResponse(
      `1|${encodeForm(validSigned)}`,
      [homeKeys, c2cKeys],
      unimartVec.options,
    );
    assert.equal(rotatedResult.kind, 'created');
    if (rotatedResult.kind === 'created') {
      assert.equal(rotatedResult.keyIndex, 1);
    }
  });

  it('parses logistics status notifications with bodySha256, dedupe, and strict allowlisting', () => {
    const vec = NOTIFICATION_GOLDEN_VECTOR;
    const signed = logistics.sign(vec.unsignedFields, c2cKeys);
    assert.equal(signed[signed.length - 1][1], vec.expectedCheckMacValue);

    const bodyText = encodeForm(signed);
    const expectedSha = createHash('sha256').update(bodyText, 'utf8').digest('hex');

    const resultFromString = parseLogisticsNotification(bodyText, c2cKeys, vec.options);
    assert.deepEqual(resultFromString, {
      ...vec.expectedWithoutBodySha256,
      bodySha256: expectedSha,
    });
    assert.equal(Object.isFrozen(resultFromString), true);
    if (resultFromString.kind === 'notification') {
      assert.equal(Object.isFrozen(resultFromString.dedupe), true);
    }

    const bodyBytes = new Uint8Array(Buffer.from(bodyText, 'utf8'));
    const expectedBytesSha = createHash('sha256').update(bodyBytes).digest('hex');
    const resultFromBytes = parseLogisticsNotification(bodyBytes, c2cKeys, vec.options);
    assert.deepEqual(resultFromBytes, {
      ...vec.expectedWithoutBodySha256,
      bodySha256: expectedBytesSha,
    });

    const serialized = JSON.stringify(resultFromString);
    for (const forbidden of ['合成買家', '0987654321', 'buyer@example.com', '12345678']) {
      assert.equal(serialized.includes(forbidden), false);
    }

    const lowerTradeNoSigned = logistics.sign(
      replaceOrRemoveField(
        vec.unsignedFields,
        'MerchantTradeNo',
        'l7k3qpz2610150902ab1',
      ),
      c2cKeys,
    );
    const lowerResult = parseLogisticsNotification(
      encodeForm(lowerTradeNoSigned),
      c2cKeys,
      vec.options,
    );
    assert.equal(lowerResult.kind, 'notification');
    if (lowerResult.kind === 'notification' && resultFromString.kind === 'notification') {
      assert.equal(lowerResult.merchantTradeNo, 'L7K3QPZ2610150902AB1');
      assert.deepEqual(lowerResult.dedupe, resultFromString.dedupe);
    }

    const tampered = signed.map(([k, v]) =>
      k === 'RtnCode' ? ([k, '300'] as const) : ([k, v] as const),
    );
    assert.deepEqual(
      parseLogisticsNotification(encodeForm(tampered), c2cKeys, vec.options),
      { kind: 'invalid', reason: 'mac_mismatch' },
    );

    const signNotif = (fields: FormFields): string =>
      encodeForm(logistics.sign(fields, c2cKeys));

    assert.deepEqual(
      parseLogisticsNotification(
        signNotif(replaceOrRemoveField(vec.unsignedFields, 'MerchantID', '2000132')),
        c2cKeys,
        vec.options,
      ),
      { kind: 'invalid', reason: 'merchant_mismatch' },
    );

    for (const requiredField of [
      'MerchantID',
      'MerchantTradeNo',
      'AllPayLogisticsID',
      'RtnCode',
      'LogisticsSubType',
      'GoodsAmount',
      'UpdateStatusDate',
    ]) {
      assert.deepEqual(
        parseLogisticsNotification(
          signNotif(replaceOrRemoveField(vec.unsignedFields, requiredField, '')),
          c2cKeys,
          vec.options,
        ),
        { kind: 'invalid', reason: 'missing_field', field: requiredField },
      );
    }

    for (const [invalidField, badVal] of [
      ['MerchantTradeNo', 'BAD_TRADE_NO'],
      ['AllPayLogisticsID', 'NOT_DIGITS'],
      ['RtnCode', '-2067'],
      ['LogisticsSubType', 'UNIMART-C2C'],
      ['GoodsAmount', '1500.00'],
      ['UpdateStatusDate', '2026-10-18T14:05:09'],
    ] as const) {
      assert.deepEqual(
        parseLogisticsNotification(
          signNotif(replaceOrRemoveField(vec.unsignedFields, invalidField, badVal)),
          c2cKeys,
          vec.options,
        ),
        { kind: 'invalid', reason: 'invalid_field', field: invalidField },
      );
    }

    const b2cSubTypeResult = parseLogisticsNotification(
      signNotif(replaceOrRemoveField(vec.unsignedFields, 'LogisticsSubType', 'UNIMART')),
      c2cKeys,
      vec.options,
    );
    assert.equal(b2cSubTypeResult.kind, 'notification');
    if (b2cSubTypeResult.kind === 'notification') {
      assert.equal(b2cSubTypeResult.logisticsSubType, 'UNIMART');
      assert.equal(b2cSubTypeResult.subType, null);
    }

    const unpaddedDateResult = parseLogisticsNotification(
      signNotif(
        replaceOrRemoveField(vec.unsignedFields, 'UpdateStatusDate', '2026/10/18 2:05:09'),
      ),
      c2cKeys,
      vec.options,
    );
    assert.equal(unpaddedDateResult.kind, 'notification');
    if (unpaddedDateResult.kind === 'notification') {
      assert.equal(unpaddedDateResult.updateStatusDate, '2026/10/18 2:05:09');
      assert.equal(unpaddedDateResult.updateStatusEpochMs, null);
    }
  });

  it('builds and parses V5 logistics queries including official erratum vector and sender PII exclusion', () => {
    expectProtocolError(
      () =>
        buildLogisticsQueryRequest(
          {
            environment: 'sandbox',
            merchantId: '2000132',
            allPayLogisticsId: '2610150004',
            merchantTradeNo: 'L8M4RS6T0VW2XY4Z6A8B',
            timestampSeconds: DOMESTIC_LOGISTICS_TIMESTAMP_SECONDS,
          },
          homeKeys,
        ),
      'invalid_input',
    );
    expectProtocolError(
      () =>
        buildLogisticsQueryRequest(
          {
            environment: 'sandbox',
            merchantId: '2000132',
            timestampSeconds: DOMESTIC_LOGISTICS_TIMESTAMP_SECONDS,
          },
          homeKeys,
        ),
      'invalid_input',
    );
    expectProtocolError(
      () =>
        parseLogisticsQueryResponse('MerchantID=2000132', homeKeys, {
          merchantId: '2000132',
          allPayLogisticsId: '2610150004',
          merchantTradeNo: 'L8M4RS6T0VW2XY4Z6A8B',
        }),
      'invalid_input',
    );
    expectProtocolError(
      () =>
        parseLogisticsQueryResponse('MerchantID=2000132', homeKeys, {
          merchantId: '2000132',
        }),
      'invalid_input',
    );

    const tcatVec = QUERY_RESPONSE_GOLDEN_VECTOR;
    const tcatSigned = logistics.sign(tcatVec.unsignedFields, homeKeys);
    assert.equal(tcatSigned[tcatSigned.length - 1][1], tcatVec.expectedCheckMacValue);

    const tcatBody = encodeForm(tcatSigned);
    const tcatResult = parseLogisticsQueryResponse(tcatBody, homeKeys, tcatVec.options);
    assert.deepEqual(tcatResult, tcatVec.expectedResult);

    const prefixedResult = parseLogisticsQueryResponse(
      `1|${tcatBody}`,
      homeKeys,
      tcatVec.options,
    );
    assert.deepEqual(prefixedResult, tcatVec.expectedResult);

    const officialV5 = CHECKMAC_VECTORS.find((v) => v.id === 'logistics-query-v5')!;
    const officialBody = encodeForm([
      ...officialV5.fields,
      ['CheckMacValue', officialV5.expectedMac],
    ]);
    const officialResult = parseLogisticsQueryResponse(officialBody, homeKeys, {
      merchantId: '2000132',
      allPayLogisticsId: '1817824',
    });
    assert.equal(officialResult.kind, 'found');
    if (officialResult.kind === 'found') {
      assert.equal(officialResult.merchantTradeNo, '20211215142334754');
      assert.equal(officialResult.allPayLogisticsId, '1817824');
      assert.equal(officialResult.logisticsStatus, '300');
      assert.equal(officialResult.logisticsType, 'CVS_UNIMART');
      assert.equal(officialResult.subType, null);
      assert.equal(officialResult.shipmentNo, '82420218218');
      assert.equal(officialResult.handlingChargeMinor, 5200);
      assert.equal(officialResult.goodsAmountMinor, 100);
      assert.deepEqual(officialResult.ignoredFields, []);
    }

    const staleBody = encodeForm([
      ...officialV5.fields,
      ['CheckMacValue', officialV5.staleDocMac!],
    ]);
    assert.deepEqual(
      parseLogisticsQueryResponse(staleBody, homeKeys, {
        merchantId: '2000132',
        allPayLogisticsId: '1817824',
      }),
      { kind: 'unknown', reason: 'mac_mismatch' },
    );

    assert.deepEqual(
      parseLogisticsQueryResponse('0|查無此筆交易資料', homeKeys, tcatVec.options),
      { kind: 'rejected', message: '查無此筆交易資料' },
    );

    const signQuery = (fields: FormFields): string =>
      encodeForm(logistics.sign(fields, homeKeys));

    assert.deepEqual(
      parseLogisticsQueryResponse(
        signQuery(replaceOrRemoveField(tcatVec.unsignedFields, 'MerchantID', '2000933')),
        homeKeys,
        tcatVec.options,
      ),
      { kind: 'unknown', reason: 'merchant_mismatch' },
    );
    assert.deepEqual(
      parseLogisticsQueryResponse(
        signQuery(
          replaceOrRemoveField(
            tcatVec.unsignedFields,
            'MerchantTradeNo',
            'L9N5ST7V1WX3YZ5A7B9C',
          ),
        ),
        homeKeys,
        tcatVec.options,
      ),
      { kind: 'unknown', reason: 'merchant_trade_no_mismatch' },
    );
    assert.deepEqual(
      parseLogisticsQueryResponse(tcatBody, homeKeys, {
        merchantId: '2000132',
        allPayLogisticsId: '2610159999',
      }),
      { kind: 'unknown', reason: 'logistics_id_mismatch' },
    );

    const badFeeResult = parseLogisticsQueryResponse(
      signQuery(replaceOrRemoveField(tcatVec.unsignedFields, 'HandlingCharge', 'abc')),
      homeKeys,
      tcatVec.options,
    );
    assert.equal(badFeeResult.kind, 'found');
    if (badFeeResult.kind === 'found') {
      assert.equal(badFeeResult.handlingChargeMinor, null);
      assert.deepEqual(badFeeResult.ignoredFields, ['HandlingCharge']);
    }

    for (const serialized of [
      JSON.stringify(tcatResult),
      JSON.stringify(officialResult),
    ]) {
      for (const forbidden of ['合成寄件', '0912345678', '訂購商品', '王大明']) {
        assert.equal(serialized.includes(forbidden), false);
      }
    }
  });

  it('enforces print form parameter rules and redacts EcpayBrowserForm and EcpayServerRequest', () => {
    expectProtocolError(
      () =>
        buildPrintLabelForm(
          {
            environment: 'sandbox',
            merchantId: '2000933',
            subType: 'FAMIC2C',
            allPayLogisticsId: '2610150002',
            cvsPaymentNo: '12345678901',
            cvsValidationNo: '1234',
          },
          c2cKeys,
        ),
      'invalid_input',
    );
    expectProtocolError(
      () =>
        buildPrintLabelForm(
          {
            environment: 'sandbox',
            merchantId: '2000933',
            subType: 'FAMIC2C',
            allPayLogisticsId: '2610150002',
            cvsPaymentNo: '12345678901',
            printMode: 'a6',
          },
          c2cKeys,
        ),
      'invalid_input',
    );
    expectProtocolError(
      () =>
        buildPrintLabelForm(
          {
            environment: 'sandbox',
            merchantId: '2000132',
            subType: 'TCAT',
            allPayLogisticsId: '2610150004',
            printMode: 'a4',
          },
          homeKeys,
        ),
      'invalid_input',
    );
    expectProtocolError(
      () =>
        buildPrintLabelForm(
          {
            environment: 'sandbox',
            merchantId: '2000132',
            subType: 'TCAT',
            allPayLogisticsId: '2610150004',
            cvsPaymentNo: '12345678',
          },
          homeKeys,
        ),
      'invalid_input',
    );
    expectProtocolError(
      () =>
        buildPrintLabelForm(
          {
            environment: 'sandbox',
            merchantId: '2000933',
            subType: 'UNIMARTC2C',
            allPayLogisticsId: '2610150001',
            cvsPaymentNo: '12345678',
          },
          c2cKeys,
        ),
      'invalid_input',
    );
    expectProtocolError(
      () => new EcpayBrowserForm(Symbol('forged'), 'https://logistics-stage.ecpay.com.tw/x'),
      'invalid_input',
    );

    const unimartPrintVec = PRINT_LABEL_GOLDEN_VECTORS[0];
    const form = buildPrintLabelForm(unimartPrintVec.input, c2cKeys);
    const mac = unimartPrintVec.expectedCheckMacValue;

    for (const repr of [
      JSON.stringify(form),
      String(form),
      `${form}`,
      util.inspect(form),
    ]) {
      assert.equal(repr.includes(mac), false);
      assert.equal(repr.includes('12345678'), false);
    }

    const fields = form.fields();
    assert.equal(Object.isFrozen(fields), true);
    for (const pair of fields) {
      assert.equal(Object.isFrozen(pair), true);
    }
    const fieldsMap = Object.fromEntries(fields);
    assert.equal(fieldsMap.CVSPaymentNo, '12345678');
    assert.equal(fieldsMap.CheckMacValue, mac);

    const createReq = buildCvsCreateOrderRequest(
      CVS_CREATE_ORDER_GOLDEN_VECTORS[0].input,
      c2cKeys,
    );
    const encodedBuyerName = dotnetUrlEncode('合成買家');
    for (const repr of [
      JSON.stringify(createReq),
      String(createReq),
      `${createReq}`,
      util.inspect(createReq),
    ]) {
      assert.equal(repr.includes('合成買家'), false);
      assert.equal(repr.toLowerCase().includes(encodedBuyerName.toLowerCase()), false);
    }
    const parsedCreate = Object.fromEntries(parseForm(createReq.bodyText()));
    assert.equal(parsedCreate.ReceiverName, '合成買家');
  });

  it('builds and parses unsigned CVS store map forms and returns', () => {
    const mobileForm = buildCvsMapForm({
      environment: 'sandbox',
      merchantId: '2000933',
      subType: 'FAMIC2C',
      serverReplyUrl: DOMESTIC_LOGISTICS_SERVER_REPLY_URL,
      extraData: 'Token12345',
      device: 'mobile',
    });
    assert.deepEqual(mobileForm.fields(), [
      ['MerchantID', '2000933'],
      ['LogisticsType', 'CVS'],
      ['LogisticsSubType', 'FAMIC2C'],
      ['IsCollection', 'N'],
      ['ServerReplyURL', DOMESTIC_LOGISTICS_SERVER_REPLY_URL],
      ['ExtraData', 'Token12345'],
      ['Device', '1'],
    ]);

    for (const badExtra of ['', 'A'.repeat(21), 'ab-c', 'Echo1234']) {
      expectProtocolError(
        () =>
          buildCvsMapForm({
            environment: 'sandbox',
            merchantId: '2000933',
            subType: 'UNIMARTC2C',
            serverReplyUrl: DOMESTIC_LOGISTICS_SERVER_REPLY_URL,
            extraData: badExtra,
            device: 'desktop',
          }),
        'invalid_input',
      );
    }
    expectProtocolError(
      () =>
        buildCvsMapForm({
          environment: 'sandbox',
          merchantId: '2000933',
          subType: 'TCAT' as unknown as 'UNIMARTC2C',
          serverReplyUrl: DOMESTIC_LOGISTICS_SERVER_REPLY_URL,
          extraData: 'Token123',
          device: 'desktop',
        }),
      'invalid_input',
    );

    const unimartMapReturnBody = encodeForm([
      ['MerchantID', '2000933'],
      ['MerchantTradeNo', 'IGNORED'],
      ['LogisticsSubType', 'UNIMARTC2C'],
      ['CVSStoreID', '131386'],
      ['CVSStoreName', '合成門市'],
      ['CVSAddress', '臺北市中正區合成路3號'],
      ['CVSTelephone', '02-23456789'],
      ['CVSOutSide', '0'],
      ['ExtraData', 'A1b2C3d4E5f6G7h8J9k0'],
    ]);
    assert.deepEqual(
      parseCvsMapReturn(unimartMapReturnBody, {
        merchantId: '2000933',
        subType: 'UNIMARTC2C',
      }),
      {
        kind: 'store',
        subType: 'UNIMARTC2C',
        storeId: '131386',
        storeName: '合成門市',
        storeAddress: '臺北市中正區合成路3號',
        outside: '0',
        extraData: 'A1b2C3d4E5f6G7h8J9k0',
        ignoredFields: [],
      },
    );

    const hilifeReturnBody = encodeForm([
      ['MerchantID', '2000933'],
      ['LogisticsSubType', 'HILIFEC2C'],
      ['CVSStoreID', '2001'],
      ['CVSStoreName', '合成萊爾富'],
      ['CVSAddress', '臺北市中正區合成路5號'],
      ['ExtraData', 'A1b2C3d4E5f6G7h8J9k0'],
    ]);
    assert.deepEqual(
      parseCvsMapReturn(hilifeReturnBody, {
        merchantId: '2000933',
        subType: 'HILIFEC2C',
      }),
      {
        kind: 'store',
        subType: 'HILIFEC2C',
        storeId: '2001',
        storeName: '合成萊爾富',
        storeAddress: '臺北市中正區合成路5號',
        outside: null,
        extraData: 'A1b2C3d4E5f6G7h8J9k0',
        ignoredFields: [],
      },
    );

    const badOutsideAndLongNameBody = encodeForm([
      ['MerchantID', '2000933'],
      ['LogisticsSubType', 'UNIMARTC2C'],
      ['CVSStoreID', '131386'],
      ['CVSStoreName', '一二三四五六\u0007七八九十一二'],
      ['CVSAddress', '臺北市中正區\u0000合成路3號'],
      ['CVSOutSide', '2'],
      ['ExtraData', 'A1b2C3d4E5f6G7h8J9k0'],
    ]);
    assert.deepEqual(
      parseCvsMapReturn(badOutsideAndLongNameBody, {
        merchantId: '2000933',
        subType: 'UNIMARTC2C',
      }),
      {
        kind: 'store',
        subType: 'UNIMARTC2C',
        storeId: '131386',
        storeName: '一二三四五六七八九十',
        storeAddress: '臺北市中正區合成路3號',
        outside: null,
        extraData: 'A1b2C3d4E5f6G7h8J9k0',
        ignoredFields: ['CVSOutSide'],
      },
    );

    assert.deepEqual(
      parseCvsMapReturn(unimartMapReturnBody, {
        merchantId: '2000132',
        subType: 'UNIMARTC2C',
      }),
      { kind: 'invalid', reason: 'merchant_mismatch' },
    );
    assert.deepEqual(
      parseCvsMapReturn(unimartMapReturnBody, {
        merchantId: '2000933',
        subType: 'FAMIC2C',
      }),
      { kind: 'invalid', reason: 'subtype_mismatch' },
    );

    assert.deepEqual(
      parseCvsMapReturn(
        encodeForm([
          ['MerchantID', '2000933'],
          ['LogisticsSubType', 'UNIMARTC2C'],
          ['CVSStoreID', ''],
          ['CVSStoreName', '合成門市'],
          ['CVSAddress', '臺北市中正區合成路3號'],
          ['ExtraData', 'Token123'],
        ]),
        { merchantId: '2000933', subType: 'UNIMARTC2C' },
      ),
      { kind: 'invalid', reason: 'missing_field', field: 'CVSStoreID' },
    );
    assert.deepEqual(
      parseCvsMapReturn(
        encodeForm([
          ['MerchantID', '2000933'],
          ['LogisticsSubType', 'UNIMARTC2C'],
          ['CVSStoreID', '1234567'],
          ['CVSStoreName', '合成門市'],
          ['CVSAddress', '臺北市中正區合成路3號'],
          ['ExtraData', 'Token123'],
        ]),
        { merchantId: '2000933', subType: 'UNIMARTC2C' },
      ),
      { kind: 'invalid', reason: 'invalid_field', field: 'CVSStoreID' },
    );
    assert.deepEqual(
      parseCvsMapReturn(
        encodeForm([
          ['MerchantID', '2000933'],
          ['LogisticsSubType', 'UNIMARTC2C'],
          ['CVSStoreID', '131386'],
          ['CVSStoreName', '合成門市'],
          ['CVSAddress', '臺北市中正區合成路3號'],
          ['ExtraData', ''],
        ]),
        { merchantId: '2000933', subType: 'UNIMARTC2C' },
      ),
      { kind: 'invalid', reason: 'missing_field', field: 'ExtraData' },
    );
    assert.deepEqual(
      parseCvsMapReturn(
        encodeForm([
          ['MerchantID', '2000933'],
          ['LogisticsSubType', 'UNIMARTC2C'],
          ['CVSStoreID', '131386'],
          ['CVSStoreName', '合成門市'],
          ['CVSAddress', '臺北市中正區合成路3號'],
          ['ExtraData', 'bad-token!'],
        ]),
        { merchantId: '2000933', subType: 'UNIMARTC2C' },
      ),
      { kind: 'invalid', reason: 'invalid_field', field: 'ExtraData' },
    );
    assert.deepEqual(
      parseCvsMapReturn('MerchantID=2000933&MerchantID=2000933', {
        merchantId: '2000933',
        subType: 'UNIMARTC2C',
      }),
      { kind: 'invalid', reason: 'duplicate_field' },
    );
    assert.deepEqual(
      parseCvsMapReturn('A'.repeat(16385), {
        merchantId: '2000933',
        subType: 'UNIMARTC2C',
      }),
      { kind: 'invalid', reason: 'form_too_large' },
    );
  });

  it('enforces C2C cancel and store update rules and parses ACK responses', () => {
    expectProtocolError(
      () =>
        buildCancelC2COrderRequest(
          {
            environment: 'sandbox',
            merchantId: '2000933',
            subType: 'FAMIC2C',
            allPayLogisticsId: '2610150002',
            cvsPaymentNo: '12345678901',
            cvsValidationNo: '1234',
          },
          c2cKeys,
        ),
      'invalid_input',
    );
    expectProtocolError(
      () =>
        buildUpdateStoreRequest(
          {
            environment: 'sandbox',
            merchantId: '2000132',
            subType: 'TCAT' as unknown as 'UNIMARTC2C',
            allPayLogisticsId: '2610150004',
            cvsPaymentNo: '12345678',
            receiverStoreId: '131386',
          },
          homeKeys,
        ),
      'invalid_input',
    );
    expectProtocolError(
      () =>
        buildUpdateStoreRequest(
          {
            environment: 'sandbox',
            merchantId: '2000933',
            subType: 'UNIMARTC2C',
            allPayLogisticsId: '2610150001',
            cvsPaymentNo: '12345678',
            receiverStoreId: '131386',
          },
          c2cKeys,
        ),
      'invalid_input',
    );
    expectProtocolError(
      () =>
        buildUpdateStoreRequest(
          {
            environment: 'sandbox',
            merchantId: '2000933',
            subType: 'FAMIC2C',
            allPayLogisticsId: '2610150002',
            cvsPaymentNo: '12345678901',
            cvsValidationNo: '1234',
            receiverStoreId: '006598',
          },
          c2cKeys,
        ),
      'invalid_input',
    );

    assert.deepEqual(parseLogisticsAckResponse('1|OK'), { kind: 'ok' });
    assert.deepEqual(parseLogisticsAckResponse('1|OK\r\n'), { kind: 'ok' });
    assert.deepEqual(parseLogisticsAckResponse('1|ok'), {
      kind: 'unknown',
      reason: 'unexpected_response',
    });
    assert.deepEqual(parseLogisticsAckResponse('1|Done'), {
      kind: 'unknown',
      reason: 'unexpected_response',
    });
    assert.deepEqual(parseLogisticsAckResponse('0|錯誤'), {
      kind: 'rejected',
      message: '錯誤',
    });
    assert.deepEqual(parseLogisticsAckResponse(''), {
      kind: 'unknown',
      reason: 'unparseable',
    });
    assert.deepEqual(parseLogisticsAckResponse('<html>Error</html>'), {
      kind: 'unknown',
      reason: 'unparseable',
    });
  });

  it('exports exact profile descriptors and serviceKey lookups', () => {
    assert.equal(ECPAY_DOMESTIC_LOGISTICS_PROFILE, 'ecpay.logistics.domestic.v1');
    assert.equal(Object.isFrozen(ECPAY_LOGISTICS_SUBTYPES), true);
    for (const desc of Object.values(ECPAY_LOGISTICS_SUBTYPES)) {
      assert.equal(Object.isFrozen(desc), true);
    }

    assert.deepEqual(ECPAY_LOGISTICS_SUBTYPES, {
      UNIMARTC2C: {
        subType: 'UNIMARTC2C',
        logisticsType: 'CVS',
        serviceKey: 'ecpay.logistics.cvs.unimartc2c',
        printPath: '/Express/PrintUniMartC2COrderInfo',
        supportsPrintMode: true,
        supportsCancel: true,
        supportsStoreUpdate: true,
        orderValidDays: 5,
        maxGoodsAmountTwd: 20000,
        maxWeightGrams: null,
      },
      FAMIC2C: {
        subType: 'FAMIC2C',
        logisticsType: 'CVS',
        serviceKey: 'ecpay.logistics.cvs.famic2c',
        printPath: '/Express/PrintFAMIC2COrderInfo',
        supportsPrintMode: false,
        supportsCancel: false,
        supportsStoreUpdate: true,
        orderValidDays: 6,
        maxGoodsAmountTwd: 20000,
        maxWeightGrams: null,
      },
      HILIFEC2C: {
        subType: 'HILIFEC2C',
        logisticsType: 'CVS',
        serviceKey: 'ecpay.logistics.cvs.hilifec2c',
        printPath: '/Express/PrintHILIFEC2COrderInfo',
        supportsPrintMode: false,
        supportsCancel: false,
        supportsStoreUpdate: true,
        orderValidDays: 7,
        maxGoodsAmountTwd: 20000,
        maxWeightGrams: null,
      },
      TCAT: {
        subType: 'TCAT',
        logisticsType: 'HOME',
        serviceKey: 'ecpay.logistics.home.tcat',
        printPath: '/helper/printTradeDocument',
        supportsPrintMode: false,
        supportsCancel: false,
        supportsStoreUpdate: false,
        orderValidDays: null,
        maxGoodsAmountTwd: null,
        maxWeightGrams: null,
      },
      POST: {
        subType: 'POST',
        logisticsType: 'HOME',
        serviceKey: 'ecpay.logistics.home.post',
        printPath: '/helper/printTradeDocument',
        supportsPrintMode: true,
        supportsCancel: false,
        supportsStoreUpdate: false,
        orderValidDays: null,
        maxGoodsAmountTwd: null,
        maxWeightGrams: 20000,
      },
    });

    assert.equal(
      subTypeForServiceKey('ecpay.logistics.cvs.unimartc2c'),
      'UNIMARTC2C',
    );
    assert.equal(subTypeForServiceKey('ecpay.logistics.cvs.famic2c'), 'FAMIC2C');
    assert.equal(
      subTypeForServiceKey('ecpay.logistics.cvs.hilifec2c'),
      'HILIFEC2C',
    );
    assert.equal(subTypeForServiceKey('ecpay.logistics.home.tcat'), 'TCAT');
    assert.equal(subTypeForServiceKey('ecpay.logistics.home.post'), 'POST');
    assert.equal(subTypeForServiceKey('ecpay.logistics.cvs.unimart'), null);
    assert.equal(subTypeForServiceKey('toString'), null);
  });

  it('matches every CDN blocked term alternative case-insensitively and preserves statelessness', () => {
    const blockedSamples: ReadonlyArray<readonly [string, string]> = [
      ['a;b', ';'],
      ['a|b', '|'],
      ['a`b', '`'],
      ['run net localgroup admins', 'net localgroup'],
      ['NET  LOCALGROUP', 'NET  LOCALGROUP'],
      ['Net\tLocalgroup', 'Net\tLocalgroup'],
      ['cmd32.exe', 'cmd32.exe'],
      ['CMD32.EXE', 'CMD32.EXE'],
      ['Cmd32.Exe', 'Cmd32.Exe'],
      ['cmd.exe', 'cmd.exe'],
      ['CMD.EXE', 'CMD.EXE'],
      ['Cmd.Exe', 'Cmd.Exe'],
      ['cmd /c dir', 'cmd /c'],
      ['CMD/C', 'CMD/C'],
      ['Cmd  /c', 'Cmd  /c'],
      ['net.exe', 'net.exe'],
      ['NET.EXE', 'NET.EXE'],
      ['Net.Exe', 'Net.Exe'],
      ['nmap.exe', 'nmap.exe'],
      ['NMAP.EXE', 'NMAP.EXE'],
      ['Nmap.Exe', 'Nmap.Exe'],
      ['nc.exe', 'nc.exe'],
      ['NC.EXE', 'NC.EXE'],
      ['Nc.Exe', 'Nc.Exe'],
      ['telnet.exe', 'telnet.exe'],
      ['TELNET.EXE', 'TELNET.EXE'],
      ['Telnet.Exe', 'Telnet.Exe'],
      ['wguest.exe', 'wguest.exe'],
      ['WGUEST.EXE', 'WGUEST.EXE'],
      ['Wguest.Exe', 'Wguest.Exe'],
      ['wsh.exe', 'wsh.exe'],
      ['WSH.EXE', 'WSH.EXE'],
      ['Wsh.Exe', 'Wsh.Exe'],
      ['rcmd.exe', 'rcmd.exe'],
      ['RCMD.EXE', 'RCMD.EXE'],
      ['Rcmd.Exe', 'Rcmd.Exe'],
      ['ftp.exe', 'ftp.exe'],
      ['FTP.EXE', 'FTP.EXE'],
      ['Ftp.Exe', 'Ftp.Exe'],
      ['traceroute', 'traceroute'],
      ['TRACEROUTE', 'TRACEROUTE'],
      ['TraceRoute', 'TraceRoute'],
      ['tracert', 'tracert'],
      ['TRACERT', 'TRACERT'],
      ['Tracert', 'Tracert'],
      ['tclsh', 'tclsh'],
      ['TCLSH', 'TCLSH'],
      ['Tclsh', 'Tclsh'],
      ['tftp', 'tftp'],
      ['TFTP', 'TFTP'],
      ['TfTp', 'TfTp'],
      ['echo', 'echo'],
      ['ECHO', 'ECHO'],
      ['Echo', 'Echo'],
      ['cd /tmp', 'cd /'],
      ['CD ..', 'CD ..'],
      ['cd\\', 'cd\\'],
      ['Cd/x', 'Cd/'],
      ['chmod +x run.sh', 'chmod +x'],
      ['CHMOD+X', 'CHMOD+X'],
      ['Chmod  +x', 'Chmod  +x'],
    ];

    for (const [sample, expectedMatch] of blockedSamples) {
      assert.equal(findCdnBlockedTerm(sample), expectedMatch);
      assert.equal(findCdnBlockedTerm(sample), expectedMatch);
    }

    for (const safeSample of [
      '合成小舖',
      'cmd',
      'chmod 755',
      'cdn',
      'e c h o',
      'net local group',
    ]) {
      assert.equal(findCdnBlockedTerm(safeSample), null);
      assert.equal(findCdnBlockedTerm(safeSample), null);
    }

    expectProtocolError(
      () => findCdnBlockedTerm(123 as unknown as string),
      'invalid_input',
    );
  });

  it('never leaks stage credentials, URLs, or synthetic PII in thrown EcpayProtocolError messages', () => {
    assert.ok(capturedErrors.length >= 25);
    const forbiddenSubstrings = [
      ...ALL_STAGE_KEY_STRINGS,
      DOMESTIC_LOGISTICS_SERVER_REPLY_URL,
      'freedom.example.com',
      DOMESTIC_LOGISTICS_CVS_SENDER.name,
      DOMESTIC_LOGISTICS_CVS_SENDER.cellPhone,
      DOMESTIC_LOGISTICS_HOME_SENDER.address,
      DOMESTIC_LOGISTICS_CVS_RECEIVER_BASE.name,
      DOMESTIC_LOGISTICS_CVS_RECEIVER_BASE.cellPhone,
      DOMESTIC_LOGISTICS_HOME_RECEIVER.address,
    ];

    for (const err of capturedErrors) {
      for (const secret of forbiddenSubstrings) {
        assert.equal(
          err.message.includes(secret),
          false,
          `Error message leaked "${secret}": ${err.message}`,
        );
      }
    }
  });
});
