import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import util from 'node:util';

import { aesDecryptString } from '../../modules/agent-commerce/providers/ecpay/aes.js';
import { sealInvoiceRequest } from '../../modules/agent-commerce/providers/ecpay/b2c-invoice/envelope.js';
import * as b2cInvoiceModule from '../../modules/agent-commerce/providers/ecpay/b2c-invoice/index.js';
import {
  ECPAY_B2C_INVOICE_PATHS,
  ECPAY_B2C_INVOICE_PROFILE,
  EcpayJsonRequest,
  buildAllowanceRequest,
  buildCancelOnlineAllowanceRequest,
  buildCheckBarcodeRequest,
  buildCheckLoveCodeRequest,
  buildCompanyNameRequest,
  buildGetAllowanceInvalidRequest,
  buildGetAllowanceListRequest,
  buildGetInvalidRequest,
  buildGetIssueRequest,
  buildIssueInvoiceRequest,
  buildOnlineAllowanceRequest,
  buildVoidAllowanceRequest,
  buildVoidInvoiceRequest,
  buildVoidWithReissueRequest,
  buildWordSettingRequest,
  classifyBarcodeCheck,
  classifyCompanyNameCheck,
  classifyInvoiceHttpStatus,
  classifyLoveCodeCheck,
  isInvoiceEmail,
  parseAllowanceConsentCallback,
  parseAllowanceResponse,
  parseCancelOnlineAllowanceResponse,
  parseCheckBarcodeResponse,
  parseCheckLoveCodeResponse,
  parseCompanyNameResponse,
  parseGetAllowanceInvalidResponse,
  parseGetAllowanceListResponse,
  parseGetInvalidResponse,
  parseGetIssueResponse,
  parseIssueInvoiceResponse,
  parseOnlineAllowanceResponse,
  parseVoidAllowanceResponse,
  parseVoidInvoiceResponse,
  parseVoidWithReissueResponse,
  parseWordSettingResponse,
  wordTrackRemaining,
  type AllowanceRequestInput,
  type IssueInvoiceRequestInput,
  type OnlineAllowanceRequestInput,
  type VoidAllowanceRequestInput,
  type VoidInvoiceRequestInput,
  type VoidWithReissueRequestInput,
  type WordSettingRequestInput,
  type WordTrack,
} from '../../modules/agent-commerce/providers/ecpay/b2c-invoice/index.js';
import {
  EcpayKeyPair,
  EcpayProtocolError,
  computeCheckMacValue,
  encodeForm,
  encryptData,
  findCdnBlockedTerm,
  formUrlDecode,
  type EcpayErrorCode,
  type FormFields,
} from '../../modules/agent-commerce/providers/ecpay/index.js';
import {
  B2C_INVOICE_ISSUE_RESPONSE_LOWER_HEX,
  B2C_INVOICE_MERCHANT_ID,
  B2C_INVOICE_REQUEST_GOLDENS,
  B2C_INVOICE_SYNTHETIC_ALLOWANCE_NO,
  B2C_INVOICE_SYNTHETIC_BARCODE,
  B2C_INVOICE_SYNTHETIC_CERTIFICATE,
  B2C_INVOICE_SYNTHETIC_COMPANY_TITLE,
  B2C_INVOICE_SYNTHETIC_DATE,
  B2C_INVOICE_SYNTHETIC_DATETIME,
  B2C_INVOICE_SYNTHETIC_EMAIL,
  B2C_INVOICE_SYNTHETIC_INVOICE_NO,
  B2C_INVOICE_SYNTHETIC_ITEMS,
  B2C_INVOICE_SYNTHETIC_LOVE_CODE,
  B2C_INVOICE_SYNTHETIC_RELATE_NUMBER,
  B2C_INVOICE_SYNTHETIC_RETURN_URL,
  B2C_INVOICE_SYNTHETIC_UBN,
  B2C_INVOICE_TIMESTAMP_SECONDS,
} from '../worker/ecpay-fixtures/b2c-invoice-vectors.js';
import { buildGoldenRequest } from '../worker/ecpay-fixtures/b2c-invoice-worker.js';
import {
  ALL_STAGE_KEY_STRINGS,
  CHECKMAC_VECTORS,
  STAGE_KEYS,
} from '../worker/ecpay-fixtures/vectors.js';

const stageKeys = EcpayKeyPair.of(
  STAGE_KEYS.invoice2000132.hashKey,
  STAGE_KEYS.invoice2000132.hashIV,
);
const otherKeys = EcpayKeyPair.of(
  STAGE_KEYS.shared2000132.hashKey,
  STAGE_KEYS.shared2000132.hashIV,
);

function assertDeepFrozen(value: unknown, seen = new Set<object>()): void {
  if (typeof value !== 'object' || value === null) {
    return;
  }
  if (seen.has(value)) {
    return;
  }
  seen.add(value);
  assert.equal(
    Object.isFrozen(value),
    true,
    `Expected object to be frozen: ${util.inspect(value)}`,
  );
  if (Array.isArray(value)) {
    for (const item of value) {
      assertDeepFrozen(item, seen);
    }
  } else {
    for (const key of Object.keys(value)) {
      assertDeepFrozen((value as Record<string, unknown>)[key], seen);
    }
  }
}

function makeEnvelope(
  dataPayload: Readonly<Record<string, unknown>>,
  overrides?: Readonly<Record<string, unknown>>,
): string {
  return JSON.stringify({
    MerchantID: B2C_INVOICE_MERCHANT_ID,
    RpHeader: { Timestamp: B2C_INVOICE_TIMESTAMP_SECONDS },
    TransCode: 1,
    TransMsg: '',
    Data: encryptData(dataPayload, stageKeys),
    ...overrides,
  });
}

function decryptEnvelopeDataJson(bodyText: string): string {
  const parsed = JSON.parse(bodyText) as { Data: string };
  const urlEncoded = aesDecryptString(parsed.Data, stageKeys);
  return formUrlDecode(urlEncoded);
}

function signAllowanceForm(
  fields: FormFields,
  keys: EcpayKeyPair = stageKeys,
): string {
  const mac = computeCheckMacValue(fields, keys, 'md5');
  return encodeForm([...fields, ['CheckMacValue', mac]]);
}

describe('ECPay B2C e-invoice profile (ecpay.invoice.b2c.v1)', () => {
  const capturedErrors: EcpayProtocolError[] = [];

  function expectProtocolError(
    fn: () => unknown,
    expectedCode: EcpayErrorCode = 'invalid_input',
  ): void {
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

  it('exports the expected profile constant, path table, and public barrel surface', () => {
    assert.equal(ECPAY_B2C_INVOICE_PROFILE, 'ecpay.invoice.b2c.v1');
    assertDeepFrozen(ECPAY_B2C_INVOICE_PATHS);
    assert.deepEqual(ECPAY_B2C_INVOICE_PATHS, {
      issue: '/B2CInvoice/Issue',
      voidWithReissue: '/B2CInvoice/VoidWithReIssue',
      void: '/B2CInvoice/Invalid',
      allowance: '/B2CInvoice/Allowance',
      onlineAllowance: '/B2CInvoice/AllowanceByCollegiate',
      voidAllowance: '/B2CInvoice/AllowanceInvalid',
      cancelOnlineAllowance: '/B2CInvoice/AllowanceInvalidByCollegiate',
      getIssue: '/B2CInvoice/GetIssue',
      getAllowanceList: '/B2CInvoice/GetAllowanceList',
      getInvalid: '/B2CInvoice/GetInvalid',
      getAllowanceInvalid: '/B2CInvoice/GetAllowanceInvalid',
      checkBarcode: '/B2CInvoice/CheckBarcode',
      checkLoveCode: '/B2CInvoice/CheckLoveCode',
      companyName: '/B2CInvoice/GetCompanyNameByTaxID',
      wordSetting: '/B2CInvoice/GetInvoiceWordSetting',
    });
    assert.deepEqual(Object.keys(ECPAY_B2C_INVOICE_PATHS), [
      'issue',
      'voidWithReissue',
      'void',
      'allowance',
      'onlineAllowance',
      'voidAllowance',
      'cancelOnlineAllowance',
      'getIssue',
      'getAllowanceList',
      'getInvalid',
      'getAllowanceInvalid',
      'checkBarcode',
      'checkLoveCode',
      'companyName',
      'wordSetting',
    ]);
    assert.equal(
      'sealInvoiceRequest' in (b2cInvoiceModule as Record<string, unknown>),
      false,
    );
  });

  it('matches all 27 request goldens, including decrypting Data and CDN whitespace variants', () => {
    assert.equal(B2C_INVOICE_REQUEST_GOLDENS.length, 27);

    const forbiddenKeys = [
      'ClearanceMark',
      'TaxAmount',
      'ItemTaxType',
      'ItemRemark',
      'ProductServiceId',
      'InvoiceHeader',
    ];

    for (const golden of B2C_INVOICE_REQUEST_GOLDENS) {
      const req = buildGoldenRequest(golden, stageKeys);
      assert.equal(req.url, golden.url, `url mismatch for ${golden.id}`);
      assert.equal(req.method, 'POST');
      assert.equal(req.contentType, 'application/json');
      assert.equal(
        req.bodyText(),
        golden.bodyText,
        `bodyText mismatch for ${golden.id}`,
      );

      const envelope = JSON.parse(req.bodyText()) as Record<string, unknown>;
      assert.deepEqual(Object.keys(envelope), [
        'PlatformID',
        'MerchantID',
        'RqHeader',
        'Data',
      ]);
      assert.equal(envelope.Data, golden.dataCipher);

      const decryptedJson = decryptEnvelopeDataJson(req.bodyText());
      assert.equal(
        decryptedJson,
        golden.dataJson,
        `decrypted JSON mismatch for ${golden.id}`,
      );

      for (const forbidden of forbiddenKeys) {
        assert.equal(
          decryptedJson.includes(`"${forbidden}"`),
          false,
          `Unexpected ${forbidden} in ${golden.id}`,
        );
      }
      if (golden.op === 'allowance' || golden.op === 'onlineAllowance') {
        assert.equal(
          decryptedJson.includes('"Reason"'),
          false,
          `Unexpected Reason in ${golden.id}`,
        );
      }

      if (golden.attempt === 0) {
        const expectedCipher = encryptData(
          JSON.parse(golden.dataJson) as Record<string, unknown>,
          stageKeys,
        );
        assert.equal(envelope.Data, expectedCipher);
      } else {
        const plainCipher = encryptData(
          JSON.parse(golden.dataJson) as Record<string, unknown>,
          stageKeys,
        );
        const plainBody = JSON.stringify({
          PlatformID: '',
          MerchantID: B2C_INVOICE_MERCHANT_ID,
          RqHeader: { Timestamp: B2C_INVOICE_TIMESTAMP_SECONDS },
          Data: plainCipher,
        });
        assert.notEqual(
          findCdnBlockedTerm(plainBody),
          null,
          `Expected plain body for ${golden.id} to trigger CDN guard`,
        );
        assert.equal(findCdnBlockedTerm(req.bodyText()), null);
        assert.equal(
          decryptedJson.startsWith(`{${' '.repeat(golden.attempt)}"`),
          true,
        );
      }
    }
  });

  it('seals requests with 1..15 leading spaces when prior attempts are blocked and throws after 16 blocked attempts', () => {
    const sampleData = {
      MerchantID: B2C_INVOICE_MERCHANT_ID,
      BarCode: B2C_INVOICE_SYNTHETIC_BARCODE,
    };

    for (let k = 1; k <= 15; k += 1) {
      let calls = 0;
      const req = sealInvoiceRequest(
        'sandbox',
        'checkBarcode',
        B2C_INVOICE_MERCHANT_ID,
        B2C_INVOICE_TIMESTAMP_SECONDS,
        sampleData,
        stageKeys,
        () => {
          calls += 1;
          return calls <= k ? 'echo' : null;
        },
      );
      assert.equal(calls, k + 1);
      const decryptedJson = decryptEnvelopeDataJson(req.bodyText());
      assert.equal(decryptedJson.startsWith(`{${' '.repeat(k)}"`), true);
      assert.deepEqual(JSON.parse(decryptedJson), sampleData);
    }

    let exhaustedCalls = 0;
    expectProtocolError(() =>
      sealInvoiceRequest(
        'sandbox',
        'checkBarcode',
        B2C_INVOICE_MERCHANT_ID,
        B2C_INVOICE_TIMESTAMP_SECONDS,
        sampleData,
        stageKeys,
        () => {
          exhaustedCalls += 1;
          return 'echo';
        },
      ),
    );
    assert.equal(exhaustedCalls, 16);
  });

  it('redacts EcpayJsonRequest bodies in JSON, String, template literals, and util.inspect and freezes instances', () => {
    const golden = B2C_INVOICE_REQUEST_GOLDENS[0];
    const req = buildGoldenRequest(golden, stageKeys);

    assert.equal(Object.isFrozen(EcpayJsonRequest), true);
    assert.equal(Object.isFrozen(EcpayJsonRequest.prototype), true);
    assert.equal(Object.isFrozen(req), true);

    const toJson = req.toJSON();
    assertDeepFrozen(toJson);
    assert.deepEqual(toJson, {
      method: 'POST',
      url: golden.url,
      contentType: 'application/json',
      body: '[redacted]',
    });

    const views = [
      JSON.stringify(req),
      String(req),
      `${req}`,
      util.inspect(req),
    ];
    for (const view of views) {
      assert.equal(view.includes(golden.dataCipher), false);
      assert.equal(view.includes(B2C_INVOICE_SYNTHETIC_EMAIL), false);
    }
    assert.equal(
      String(req),
      `EcpayJsonRequest POST ${golden.url} [body redacted]`,
    );

    expectProtocolError(
      () =>
        new (EcpayJsonRequest as unknown as new (
          token: unknown,
          url: string,
        ) => EcpayJsonRequest)({}, golden.url),
    );
  });

  it('rejects invalid caller inputs across all builders with invalid_input', () => {
    const validIssueInput: IssueInvoiceRequestInput = {
      environment: 'sandbox',
      merchantId: B2C_INVOICE_MERCHANT_ID,
      timestampSeconds: B2C_INVOICE_TIMESTAMP_SECONDS,
      relateNumber: B2C_INVOICE_SYNTHETIC_RELATE_NUMBER,
      buyer: { type: 'member_carrier' },
      email: B2C_INVOICE_SYNTHETIC_EMAIL,
      salesAmountMinor: 150000,
      remark: '合成訂單備註',
      itemWord: '式',
      items: B2C_INVOICE_SYNTHETIC_ITEMS,
    };

    const validReissueInput: VoidWithReissueRequestInput = {
      ...validIssueInput,
      invoiceNo: B2C_INVOICE_SYNTHETIC_INVOICE_NO,
      voidReason: '買家統編更正',
      invoiceDateTime: B2C_INVOICE_SYNTHETIC_DATETIME,
    };

    const validVoidInput: VoidInvoiceRequestInput = {
      environment: 'sandbox',
      merchantId: B2C_INVOICE_MERCHANT_ID,
      timestampSeconds: B2C_INVOICE_TIMESTAMP_SECONDS,
      invoiceNo: B2C_INVOICE_SYNTHETIC_INVOICE_NO,
      invoiceDate: B2C_INVOICE_SYNTHETIC_DATE,
      reason: '訂單取消作廢',
    };

    const validAllowanceInput: AllowanceRequestInput = {
      environment: 'sandbox',
      merchantId: B2C_INVOICE_MERCHANT_ID,
      timestampSeconds: B2C_INVOICE_TIMESTAMP_SECONDS,
      invoiceNo: B2C_INVOICE_SYNTHETIC_INVOICE_NO,
      invoiceDate: B2C_INVOICE_SYNTHETIC_DATE,
      companyTitle: B2C_INVOICE_SYNTHETIC_COMPANY_TITLE,
      email: B2C_INVOICE_SYNTHETIC_EMAIL,
      allowanceAmountMinor: 150000,
      itemWord: '式',
      items: B2C_INVOICE_SYNTHETIC_ITEMS,
    };

    const validOnlineAllowanceInput: OnlineAllowanceRequestInput = {
      ...validAllowanceInput,
      returnUrl: B2C_INVOICE_SYNTHETIC_RETURN_URL,
    };

    const validVoidAllowanceInput: VoidAllowanceRequestInput = {
      environment: 'sandbox',
      merchantId: B2C_INVOICE_MERCHANT_ID,
      timestampSeconds: B2C_INVOICE_TIMESTAMP_SECONDS,
      invoiceNo: B2C_INVOICE_SYNTHETIC_INVOICE_NO,
      allowanceNo: B2C_INVOICE_SYNTHETIC_ALLOWANCE_NO,
      reason: '折讓金額更正',
    };

    const validWordSettingInput: WordSettingRequestInput = {
      environment: 'sandbox',
      merchantId: B2C_INVOICE_MERCHANT_ID,
      timestampSeconds: B2C_INVOICE_TIMESTAMP_SECONDS,
      invoiceYear: '115',
      invoiceTerm: 5,
      useStatus: 0,
      invType: '07',
    };

    // Context: environment, merchant, timestamps
    expectProtocolError(() =>
      buildIssueInvoiceRequest(
        { ...validIssueInput, environment: 'stage' as 'sandbox' },
        stageKeys,
      ),
    );
    expectProtocolError(() =>
      buildIssueInvoiceRequest(
        { ...validIssueInput, merchantId: '123' },
        stageKeys,
      ),
    );
    for (const badTs of [0, -1, 1.5, '1792044000']) {
      expectProtocolError(() =>
        buildIssueInvoiceRequest(
          { ...validIssueInput, timestampSeconds: badTs as number },
          stageKeys,
        ),
      );
    }

    // Relate numbers: prefix F, lower case, 19 symbols, containing U
    for (const badRelate of [
      'F0200000000000000001',
      'I020000000000000000a',
      'I020000000000000001',
      'I020000000000000000U',
    ]) {
      expectProtocolError(() =>
        buildIssueInvoiceRequest(
          { ...validIssueInput, relateNumber: badRelate },
          stageKeys,
        ),
      );
    }

    // Invoice numbers: AB1234567, ab12345678, AB123456789
    for (const badInvNo of ['AB1234567', 'ab12345678', 'AB123456789']) {
      expectProtocolError(() =>
        buildVoidInvoiceRequest(
          { ...validVoidInput, invoiceNo: badInvNo },
          stageKeys,
        ),
      );
    }

    // Allowance numbers: 15 and 17 digits
    for (const badAllowNo of ['202610150000001', '20261015000000001']) {
      expectProtocolError(() =>
        buildVoidAllowanceRequest(
          { ...validVoidAllowanceInput, allowanceNo: badAllowNo },
          stageKeys,
        ),
      );
    }

    // Dates: 2026/10/15, 2026-02-30, 2026-13-01, 1999-12-31
    for (const badDate of [
      '2026/10/15',
      '2026-02-30',
      '2026-13-01',
      '1999-12-31',
    ]) {
      expectProtocolError(() =>
        buildVoidInvoiceRequest(
          { ...validVoidInput, invoiceDate: badDate },
          stageKeys,
        ),
      );
    }

    // Date-times: 2026-10-15 24:00:00, 2026-10-15T10:20:30
    for (const badDateTime of ['2026-10-15 24:00:00', '2026-10-15T10:20:30']) {
      expectProtocolError(() =>
        buildVoidWithReissueRequest(
          { ...validReissueInput, invoiceDateTime: badDateTime },
          stageKeys,
        ),
      );
    }

    // Reasons: '', 21 code points, with \n, with leading space, with lone surrogate
    for (const badReason of [
      '',
      '一'.repeat(21),
      '原因\n換行',
      ' 前導空白',
      '原因\uD800孤立',
    ]) {
      expectProtocolError(() =>
        buildVoidInvoiceRequest(
          { ...validVoidInput, reason: badReason },
          stageKeys,
        ),
      );
    }

    // Buyers: unknown type, extra key, bad barcode, bad certificate, bad love codes, bad ubn, bad titles
    expectProtocolError(() =>
      buildIssueInvoiceRequest(
        {
          ...validIssueInput,
          buyer: { type: 'unknown' } as unknown as IssueInvoiceRequestInput['buyer'],
        },
        stageKeys,
      ),
    );
    expectProtocolError(() =>
      buildIssueInvoiceRequest(
        {
          ...validIssueInput,
          buyer: {
            type: 'donation',
            loveCode: '000123',
            ubn: '97025978',
          } as unknown as IssueInvoiceRequestInput['buyer'],
        },
        stageKeys,
      ),
    );
    for (const badBarcode of ['/ab12+-.', '/AB12+-']) {
      expectProtocolError(() =>
        buildIssueInvoiceRequest(
          {
            ...validIssueInput,
            buyer: { type: 'mobile_barcode', barcode: badBarcode },
          },
          stageKeys,
        ),
      );
    }
    expectProtocolError(() =>
      buildIssueInvoiceRequest(
        {
          ...validIssueInput,
          buyer: { type: 'citizen_cert', certificate: 'ab12345678901234' },
        },
        stageKeys,
      ),
    );
    for (const badLoveCode of ['12', '12345678']) {
      expectProtocolError(() =>
        buildIssueInvoiceRequest(
          {
            ...validIssueInput,
            buyer: { type: 'donation', loveCode: badLoveCode },
          },
          stageKeys,
        ),
      );
    }
    expectProtocolError(() =>
      buildIssueInvoiceRequest(
        {
          ...validIssueInput,
          buyer: {
            type: 'company',
            ubn: '9702597',
            title: B2C_INVOICE_SYNTHETIC_COMPANY_TITLE,
          },
        },
        stageKeys,
      ),
    );
    for (const badTitle of ['', '公'.repeat(61), '公司\u0007名稱']) {
      expectProtocolError(() =>
        buildIssueInvoiceRequest(
          {
            ...validIssueInput,
            buyer: {
              type: 'company',
              ubn: B2C_INVOICE_SYNTHETIC_UBN,
              title: badTitle,
            },
          },
          stageKeys,
        ),
      );
    }

    // Items: [], 201 items, name '', 101 code points, C0 character, count 0/100/1.5, priceMinor 0/9650, amountMinor != count * price, extra key, sum != total
    expectProtocolError(() =>
      buildIssueInvoiceRequest({ ...validIssueInput, items: [] }, stageKeys),
    );
    expectProtocolError(() =>
      buildIssueInvoiceRequest(
        {
          ...validIssueInput,
          salesAmountMinor: 20100,
          items: Array.from({ length: 201 }, () => ({
            name: '品項',
            count: 1,
            priceMinor: 100,
            amountMinor: 100,
          })),
        },
        stageKeys,
      ),
    );
    for (const badItemName of ['', '品'.repeat(101), '品項\u0000名稱']) {
      expectProtocolError(() =>
        buildIssueInvoiceRequest(
          {
            ...validIssueInput,
            salesAmountMinor: 10000,
            items: [
              {
                name: badItemName,
                count: 1,
                priceMinor: 10000,
                amountMinor: 10000,
              },
            ],
          },
          stageKeys,
        ),
      );
    }
    for (const badCount of [0, 100, 1.5]) {
      expectProtocolError(() =>
        buildIssueInvoiceRequest(
          {
            ...validIssueInput,
            salesAmountMinor: 10000,
            items: [
              {
                name: '品項',
                count: badCount,
                priceMinor: 10000,
                amountMinor: 10000,
              },
            ],
          },
          stageKeys,
        ),
      );
    }
    for (const badPrice of [0, 9650]) {
      expectProtocolError(() =>
        buildIssueInvoiceRequest(
          {
            ...validIssueInput,
            salesAmountMinor: badPrice || 10000,
            items: [
              {
                name: '品項',
                count: 1,
                priceMinor: badPrice,
                amountMinor: badPrice || 10000,
              },
            ],
          },
          stageKeys,
        ),
      );
    }
    expectProtocolError(() =>
      buildIssueInvoiceRequest(
        {
          ...validIssueInput,
          salesAmountMinor: 20000,
          items: [
            {
              name: '品項',
              count: 2,
              priceMinor: 10000,
              amountMinor: 10000,
            },
          ],
        },
        stageKeys,
      ),
    );
    expectProtocolError(() =>
      buildIssueInvoiceRequest(
        {
          ...validIssueInput,
          salesAmountMinor: 10000,
          items: [
            {
              name: '品項',
              count: 1,
              priceMinor: 10000,
              amountMinor: 10000,
              extra: 'x',
            } as unknown as IssueInvoiceRequestInput['items'][number],
          ],
        },
        stageKeys,
      ),
    );
    expectProtocolError(() =>
      buildIssueInvoiceRequest(
        {
          ...validIssueInput,
          salesAmountMinor: 20000,
          items: [
            {
              name: '品項',
              count: 1,
              priceMinor: 10000,
              amountMinor: 10000,
            },
          ],
        },
        stageKeys,
      ),
    );

    // Item words: '' and 7 code points
    for (const badWord of ['', '單位名稱超過六']) {
      expectProtocolError(() =>
        buildIssueInvoiceRequest(
          { ...validIssueInput, itemWord: badWord },
          stageKeys,
        ),
      );
    }

    // Remarks: '' and 201 code points
    for (const badRemark of ['', '備'.repeat(201)]) {
      expectProtocolError(() =>
        buildIssueInvoiceRequest(
          { ...validIssueInput, remark: badRemark },
          stageKeys,
        ),
      );
    }

    // companyTitle: ''
    expectProtocolError(() =>
      buildAllowanceRequest(
        { ...validAllowanceInput, companyTitle: '' },
        stageKeys,
      ),
    );

    // returnUrl: http://..., with ?, 201 characters
    for (const badUrl of [
      'http://freedom.example.com/callback',
      'https://freedom.example.com/callback?a=1',
      `https://freedom.example.com/${'a'.repeat(173)}`,
    ]) {
      expectProtocolError(() =>
        buildOnlineAllowanceRequest(
          { ...validOnlineAllowanceInput, returnUrl: badUrl },
          stageKeys,
        ),
      );
    }

    // by unknown
    expectProtocolError(() =>
      buildGetIssueRequest(
        {
          environment: 'sandbox',
          merchantId: B2C_INVOICE_MERCHANT_ID,
          timestampSeconds: B2C_INVOICE_TIMESTAMP_SECONDS,
          by: 'other' as 'relate_number',
          relateNumber: B2C_INVOICE_SYNTHETIC_RELATE_NUMBER,
        },
        stageKeys,
      ),
    );
    expectProtocolError(() =>
      buildGetAllowanceListRequest(
        {
          environment: 'sandbox',
          merchantId: B2C_INVOICE_MERCHANT_ID,
          timestampSeconds: B2C_INVOICE_TIMESTAMP_SECONDS,
          by: 'other' as 'allowance_no',
          allowanceNo: B2C_INVOICE_SYNTHETIC_ALLOWANCE_NO,
        },
        stageKeys,
      ),
    );
    expectProtocolError(() =>
      parseGetAllowanceListResponse('{}', stageKeys, {
        merchantId: B2C_INVOICE_MERCHANT_ID,
      }),
    );

    // Word-setting: year 2026 and 11, term 7 and -1, status 7, invType '09'
    for (const badYear of ['2026', '11']) {
      expectProtocolError(() =>
        buildWordSettingRequest(
          { ...validWordSettingInput, invoiceYear: badYear },
          stageKeys,
        ),
      );
    }
    for (const badTerm of [7, -1]) {
      expectProtocolError(() =>
        buildWordSettingRequest(
          {
            ...validWordSettingInput,
            invoiceTerm: badTerm as WordSettingRequestInput['invoiceTerm'],
          },
          stageKeys,
        ),
      );
    }
    expectProtocolError(() =>
      buildWordSettingRequest(
        {
          ...validWordSettingInput,
          useStatus: 7 as WordSettingRequestInput['useStatus'],
        },
        stageKeys,
      ),
    );
    expectProtocolError(() =>
      buildWordSettingRequest(
        {
          ...validWordSettingInput,
          invType: '09' as WordSettingRequestInput['invType'],
        },
        stageKeys,
      ),
    );
  });

  it('validates e-mail addresses with isInvoiceEmail', () => {
    const eightyCharEmail = `${'a'.repeat(67)}@example.test`;
    assert.equal(eightyCharEmail.length, 80);

    const accepted = [
      'buyer@example.test',
      'a.b+c@sub.example.com',
      'x_y-z@a-b.example.tw',
      eightyCharEmail,
    ];
    for (const addr of accepted) {
      assert.equal(isInvoiceEmail(addr), true, `Expected ${addr} to be valid`);
    }

    const eightyOneCharEmail = `${'a'.repeat(68)}@example.test`;
    assert.equal(eightyOneCharEmail.length, 81);

    const rejected: unknown[] = [
      '',
      'buyer',
      '@example.test',
      'buyer@',
      'buyer@example',
      'buyer@-example.test',
      'buyer@example-.test',
      'buyer..x@example.test',
      '.buyer@example.test',
      'buyer.@example.test',
      'buyer@example.t3',
      'buyer@example.123',
      "o'neil@example.test",
      '買家@example.test',
      'buyer@例子.test',
      'buyer @example.test',
      'buyer@example.test ',
      eightyOneCharEmail,
      'a@example.test,b@example.test',
      'a@b@example.test',
      null,
      undefined,
      123,
      {},
    ];
    for (const addr of rejected) {
      assert.equal(
        isInvoiceEmail(addr),
        false,
        `Expected ${String(addr)} to be rejected`,
      );
    }
  });

  it('parses responses across all 15 parsers, enforcing envelope rules, missing/invalid fields, echo checks, date formats, and amounts', () => {
    const merchantId = B2C_INVOICE_MERCHANT_ID;

    // Independent lower-hex response golden
    const lowerHexResult = parseIssueInvoiceResponse(
      B2C_INVOICE_ISSUE_RESPONSE_LOWER_HEX.body,
      stageKeys,
      { merchantId },
    );
    assertDeepFrozen(lowerHexResult);
    assert.deepEqual(lowerHexResult, {
      kind: 'ok',
      value: B2C_INVOICE_ISSUE_RESPONSE_LOWER_HEX.expected,
    });

    // Envelope-level variations on parseIssueInvoiceResponse
    const baseIssuePayload = {
      RtnCode: 1,
      RtnMsg: '開立發票成功',
      InvoiceNo: B2C_INVOICE_SYNTHETIC_INVOICE_NO,
      InvoiceDate: '2026-10-15 10:20:30',
      RandomNumber: '7412',
    };
    assert.deepEqual(
      parseIssueInvoiceResponse(
        makeEnvelope({ ...baseIssuePayload, RtnCode: '1' }),
        stageKeys,
        { merchantId },
      ),
      {
        kind: 'ok',
        value: {
          invoiceNo: B2C_INVOICE_SYNTHETIC_INVOICE_NO,
          invoiceDateTime: '2026-10-15 10:20:30',
          invoiceAtEpochMs: 1792030830000,
          randomNumber: '7412',
        },
      },
    );
    assert.deepEqual(
      parseIssueInvoiceResponse(
        makeEnvelope(baseIssuePayload, { PlatformID: '' }),
        stageKeys,
        { merchantId },
      ),
      {
        kind: 'ok',
        value: {
          invoiceNo: B2C_INVOICE_SYNTHETIC_INVOICE_NO,
          invoiceDateTime: '2026-10-15 10:20:30',
          invoiceAtEpochMs: 1792030830000,
          randomNumber: '7412',
        },
      },
    );
    assert.deepEqual(
      parseIssueInvoiceResponse(
        makeEnvelope(baseIssuePayload, { MerchantID: '2000133' }),
        stageKeys,
        { merchantId },
      ),
      { kind: 'unknown', reason: 'merchant_mismatch' },
    );
    assert.deepEqual(
      parseIssueInvoiceResponse(
        makeEnvelope(baseIssuePayload, { MerchantID: 2000132 }),
        stageKeys,
        { merchantId },
      ),
      { kind: 'unknown', reason: 'merchant_mismatch' },
    );
    assert.deepEqual(
      parseIssueInvoiceResponse(
        makeEnvelope(baseIssuePayload, {
          TransCode: 0,
          TransMsg: '參數錯誤',
        }),
        stageKeys,
        { merchantId },
      ),
      { kind: 'not_accepted', transCode: '0', transMsg: '參數錯誤' },
    );
    assert.deepEqual(
      parseIssueInvoiceResponse(
        makeEnvelope({
          ...baseIssuePayload,
          RtnCode: 5070350,
          RtnMsg: '重複開立',
        }),
        stageKeys,
        { merchantId },
      ),
      { kind: 'rejected', rtnCode: '5070350', rtnMsg: '重複開立' },
    );
    assert.deepEqual(
      parseIssueInvoiceResponse('not json', stageKeys, { merchantId }),
      { kind: 'unknown', reason: 'invalid_json' },
    );
    assert.deepEqual(
      parseIssueInvoiceResponse(
        makeEnvelope(baseIssuePayload, { Data: '!!!not-base64!!!' }),
        stageKeys,
        { merchantId },
      ),
      { kind: 'unknown', reason: 'invalid_base64' },
    );
    assert.deepEqual(
      parseIssueInvoiceResponse(
        makeEnvelope(baseIssuePayload, { Data: 'AAAAAAAAAAAAAAAAAAAAAA==' }),
        stageKeys,
        { merchantId },
      ),
      { kind: 'unknown', reason: 'decrypt_failed' },
    );

    // Date-time with '/' -> ok in dash form; mixed or date-only -> invalid_field
    assert.deepEqual(
      parseIssueInvoiceResponse(
        makeEnvelope({
          ...baseIssuePayload,
          InvoiceDate: '2026/10/15 10:20:30',
        }),
        stageKeys,
        { merchantId },
      ),
      {
        kind: 'ok',
        value: {
          invoiceNo: B2C_INVOICE_SYNTHETIC_INVOICE_NO,
          invoiceDateTime: '2026-10-15 10:20:30',
          invoiceAtEpochMs: 1792030830000,
          randomNumber: '7412',
        },
      },
    );
    for (const badDt of ['2019-09/17 17:17:31', '2026-10-15']) {
      assert.deepEqual(
        parseIssueInvoiceResponse(
          makeEnvelope({ ...baseIssuePayload, InvoiceDate: badDt }),
          stageKeys,
          { merchantId },
        ),
        { kind: 'unknown', reason: 'invalid_field', field: 'InvoiceDate' },
      );
    }

    // Issue & VoidWithReissue required/malformed fields
    for (const parser of [
      parseIssueInvoiceResponse,
      parseVoidWithReissueResponse,
    ]) {
      const okRes = parser(makeEnvelope(baseIssuePayload), stageKeys, {
        merchantId,
      });
      assertDeepFrozen(okRes);
      assert.equal(okRes.kind, 'ok');

      for (const field of ['InvoiceNo', 'InvoiceDate', 'RandomNumber']) {
        assert.deepEqual(
          parser(
            makeEnvelope({ ...baseIssuePayload, [field]: '' }),
            stageKeys,
            { merchantId },
          ),
          { kind: 'unknown', reason: 'missing_field', field },
        );
        assert.deepEqual(
          parser(
            makeEnvelope({ ...baseIssuePayload, [field]: 'bad-val' }),
            stageKeys,
            { merchantId },
          ),
          { kind: 'unknown', reason: 'invalid_field', field },
        );
      }
    }

    // Void parser
    assert.deepEqual(
      parseVoidInvoiceResponse(
        makeEnvelope({ RtnCode: 1, RtnMsg: 'ok', InvoiceNo: 'AB12345678' }),
        stageKeys,
        { merchantId, invoiceNo: 'AB12345678' },
      ),
      { kind: 'ok', value: { invoiceNo: 'AB12345678' } },
    );
    assert.deepEqual(
      parseVoidInvoiceResponse(
        makeEnvelope({ RtnCode: 1, RtnMsg: 'ok', InvoiceNo: '' }),
        stageKeys,
        { merchantId, invoiceNo: 'AB12345678' },
      ),
      { kind: 'unknown', reason: 'missing_field', field: 'InvoiceNo' },
    );
    assert.deepEqual(
      parseVoidInvoiceResponse(
        makeEnvelope({ RtnCode: 1, RtnMsg: 'ok', InvoiceNo: 'bad' }),
        stageKeys,
        { merchantId, invoiceNo: 'AB12345678' },
      ),
      { kind: 'unknown', reason: 'invalid_field', field: 'InvoiceNo' },
    );
    assert.deepEqual(
      parseVoidInvoiceResponse(
        makeEnvelope({ RtnCode: 1, RtnMsg: 'ok', InvoiceNo: 'CD87654321' }),
        stageKeys,
        { merchantId, invoiceNo: 'AB12345678' },
      ),
      { kind: 'unknown', reason: 'invoice_no_mismatch', field: 'InvoiceNo' },
    );

    // Allowance parser + amount formats
    const baseAllowPayload = {
      RtnCode: 1,
      RtnMsg: 'ok',
      IA_Allow_No: B2C_INVOICE_SYNTHETIC_ALLOWANCE_NO,
      IA_Invoice_No: B2C_INVOICE_SYNTHETIC_INVOICE_NO,
      IA_Date: '2026-10-16 11:22:33',
      IA_Remain_Allowance_Amt: 1000,
    };
    const allowAsNum = parseAllowanceResponse(
      makeEnvelope(baseAllowPayload),
      stageKeys,
      { merchantId, invoiceNo: B2C_INVOICE_SYNTHETIC_INVOICE_NO },
    );
    const allowAsStr = parseAllowanceResponse(
      makeEnvelope({ ...baseAllowPayload, IA_Remain_Allowance_Amt: '1000' }),
      stageKeys,
      { merchantId, invoiceNo: B2C_INVOICE_SYNTHETIC_INVOICE_NO },
    );
    assert.equal(allowAsNum.kind, 'ok');
    assert.deepEqual(allowAsNum, allowAsStr);

    for (const badAmt of [-1, 1.5, '1e3']) {
      assert.deepEqual(
        parseAllowanceResponse(
          makeEnvelope({
            ...baseAllowPayload,
            IA_Remain_Allowance_Amt: badAmt,
          }),
          stageKeys,
          { merchantId, invoiceNo: B2C_INVOICE_SYNTHETIC_INVOICE_NO },
        ),
        {
          kind: 'unknown',
          reason: 'invalid_field',
          field: 'IA_Remain_Allowance_Amt',
        },
      );
    }
    for (const field of [
      'IA_Allow_No',
      'IA_Invoice_No',
      'IA_Date',
      'IA_Remain_Allowance_Amt',
    ]) {
      assert.deepEqual(
        parseAllowanceResponse(
          makeEnvelope({ ...baseAllowPayload, [field]: '' }),
          stageKeys,
          { merchantId, invoiceNo: B2C_INVOICE_SYNTHETIC_INVOICE_NO },
        ),
        { kind: 'unknown', reason: 'missing_field', field },
      );
      assert.deepEqual(
        parseAllowanceResponse(
          makeEnvelope({ ...baseAllowPayload, [field]: 'bad' }),
          stageKeys,
          { merchantId, invoiceNo: B2C_INVOICE_SYNTHETIC_INVOICE_NO },
        ),
        { kind: 'unknown', reason: 'invalid_field', field },
      );
    }
    assert.deepEqual(
      parseAllowanceResponse(
        makeEnvelope({ ...baseAllowPayload, IA_Invoice_No: 'CD87654321' }),
        stageKeys,
        { merchantId, invoiceNo: B2C_INVOICE_SYNTHETIC_INVOICE_NO },
      ),
      {
        kind: 'unknown',
        reason: 'invoice_no_mismatch',
        field: 'IA_Invoice_No',
      },
    );

    // Online allowance parser
    const baseOnlineAllowPayload = {
      RtnCode: 1,
      RtnMsg: 'ok',
      IA_Allow_No: B2C_INVOICE_SYNTHETIC_ALLOWANCE_NO,
      IA_Invoice_No: B2C_INVOICE_SYNTHETIC_INVOICE_NO,
      IA_TempDate: '2026-10-16 11:22:33',
      IA_TempExpireDate: '2026-10-21 11:22:33',
      IA_Remain_Allowance_Amt: 1000,
    };
    const onlineAllowOk = parseOnlineAllowanceResponse(
      makeEnvelope(baseOnlineAllowPayload),
      stageKeys,
      { merchantId, invoiceNo: B2C_INVOICE_SYNTHETIC_INVOICE_NO },
    );
    assertDeepFrozen(onlineAllowOk);
    assert.equal(onlineAllowOk.kind, 'ok');
    for (const field of [
      'IA_Allow_No',
      'IA_Invoice_No',
      'IA_TempDate',
      'IA_TempExpireDate',
      'IA_Remain_Allowance_Amt',
    ]) {
      assert.deepEqual(
        parseOnlineAllowanceResponse(
          makeEnvelope({ ...baseOnlineAllowPayload, [field]: null }),
          stageKeys,
          { merchantId, invoiceNo: B2C_INVOICE_SYNTHETIC_INVOICE_NO },
        ),
        { kind: 'unknown', reason: 'missing_field', field },
      );
      assert.deepEqual(
        parseOnlineAllowanceResponse(
          makeEnvelope({ ...baseOnlineAllowPayload, [field]: 'bad' }),
          stageKeys,
          { merchantId, invoiceNo: B2C_INVOICE_SYNTHETIC_INVOICE_NO },
        ),
        { kind: 'unknown', reason: 'invalid_field', field },
      );
    }
    assert.deepEqual(
      parseOnlineAllowanceResponse(
        makeEnvelope({
          ...baseOnlineAllowPayload,
          IA_Invoice_No: 'CD87654321',
        }),
        stageKeys,
        { merchantId, invoiceNo: B2C_INVOICE_SYNTHETIC_INVOICE_NO },
      ),
      {
        kind: 'unknown',
        reason: 'invoice_no_mismatch',
        field: 'IA_Invoice_No',
      },
    );

    // VoidAllowance & CancelOnlineAllowance parsers
    for (const parser of [
      parseVoidAllowanceResponse,
      parseCancelOnlineAllowanceResponse,
    ]) {
      assert.deepEqual(
        parser(
          makeEnvelope({
            RtnCode: 1,
            RtnMsg: 'ok',
            IA_Invoice_No: B2C_INVOICE_SYNTHETIC_INVOICE_NO,
          }),
          stageKeys,
          { merchantId, invoiceNo: B2C_INVOICE_SYNTHETIC_INVOICE_NO },
        ),
        {
          kind: 'ok',
          value: { invoiceNo: B2C_INVOICE_SYNTHETIC_INVOICE_NO },
        },
      );
      assert.deepEqual(
        parser(
          makeEnvelope({ RtnCode: 1, RtnMsg: 'ok', IA_Invoice_No: '' }),
          stageKeys,
          { merchantId, invoiceNo: B2C_INVOICE_SYNTHETIC_INVOICE_NO },
        ),
        { kind: 'unknown', reason: 'missing_field', field: 'IA_Invoice_No' },
      );
      assert.deepEqual(
        parser(
          makeEnvelope({ RtnCode: 1, RtnMsg: 'ok', IA_Invoice_No: 'bad' }),
          stageKeys,
          { merchantId, invoiceNo: B2C_INVOICE_SYNTHETIC_INVOICE_NO },
        ),
        { kind: 'unknown', reason: 'invalid_field', field: 'IA_Invoice_No' },
      );
      assert.deepEqual(
        parser(
          makeEnvelope({
            RtnCode: 1,
            RtnMsg: 'ok',
            IA_Invoice_No: 'CD87654321',
          }),
          stageKeys,
          { merchantId, invoiceNo: B2C_INVOICE_SYNTHETIC_INVOICE_NO },
        ),
        {
          kind: 'unknown',
          reason: 'invoice_no_mismatch',
          field: 'IA_Invoice_No',
        },
      );
    }
  });

  it('drops all buyer PII fields in getIssue, getAllowanceList, getInvalid, and getAllowanceInvalid and maps status/turnkey flags', () => {
    const merchantId = B2C_INVOICE_MERCHANT_ID;
    const piiMarkers = [
      '王小明',
      'pii-secret@example.test',
      '台北市信義區松壽路99號',
      '0911222333',
      '97025978',
      '/PIIBAR1',
      '999888',
      '203.0.113.42',
      '機密商品名稱',
    ];

    const fullGetIssuePayload = {
      RtnCode: 1,
      RtnMsg: '查詢成功',
      IIS_Number: B2C_INVOICE_SYNTHETIC_INVOICE_NO,
      IIS_Relate_Number: B2C_INVOICE_SYNTHETIC_RELATE_NUMBER,
      IIS_Create_Date: '2026-10-15 10:20:30',
      IIS_Issue_Status: '1',
      IIS_Invalid_Status: '0',
      IIS_Upload_Status: '0',
      IIS_Upload_Date: '',
      IIS_Turnkey_Status: '',
      IIS_Sales_Amount: '1500',
      IIS_Remain_Allowance_Amt: '1500',
      IIS_Random_Number: '7412',
      IIS_Customer_Name: '王小明',
      IIS_Customer_Email: 'pii-secret@example.test',
      IIS_Customer_Addr: '台北市信義區松壽路99號',
      IIS_Customer_Phone: '0911222333',
      IIS_Identifier: '97025978',
      IIS_Carrier_Num: '/PIIBAR1',
      IIS_Love_Code: '999888',
      IIS_IP: '203.0.113.42',
      Items: [{ ItemName: '機密商品名稱', ItemAmount: 1500 }],
    };

    const getIssueRes = parseGetIssueResponse(
      makeEnvelope(fullGetIssuePayload),
      stageKeys,
      {
        merchantId,
        by: 'relate_number',
        relateNumber: B2C_INVOICE_SYNTHETIC_RELATE_NUMBER,
      },
    );
    assertDeepFrozen(getIssueRes);
    assert.deepEqual(getIssueRes, {
      kind: 'ok',
      value: {
        invoiceNo: B2C_INVOICE_SYNTHETIC_INVOICE_NO,
        relateNumber: B2C_INVOICE_SYNTHETIC_RELATE_NUMBER,
        issuedDateTime: '2026-10-15 10:20:30',
        issuedAtEpochMs: 1792030830000,
        issueStatus: 'issued',
        voided: false,
        uploaded: false,
        uploadedDateTime: null,
        uploadedAtEpochMs: null,
        turnkeyStatus: null,
        salesAmountMinor: 150000,
        remainingAllowanceMinor: 150000,
        randomNumber: '7412',
      },
    });
    const serializedGetIssue = JSON.stringify(getIssueRes);
    for (const marker of piiMarkers) {
      assert.equal(serializedGetIssue.includes(marker), false);
    }

    // Status flag and turnkey tables + external relateNumber on query by invoice_no
    const cancelledFailedRes = parseGetIssueResponse(
      makeEnvelope({
        ...fullGetIssuePayload,
        IIS_Relate_Number: 'EXT-ORDER-2026-0001',
        IIS_Issue_Status: '0',
        IIS_Invalid_Status: '1',
        IIS_Upload_Status: '1',
        IIS_Upload_Date: '2026/10/15 12:00:00',
        IIS_Turnkey_Status: 'E',
      }),
      stageKeys,
      {
        merchantId,
        by: 'invoice_no',
        invoiceNo: B2C_INVOICE_SYNTHETIC_INVOICE_NO,
      },
    );
    assert.equal(cancelledFailedRes.kind, 'ok');
    if (cancelledFailedRes.kind === 'ok') {
      assert.equal(cancelledFailedRes.value.relateNumber, 'EXT-ORDER-2026-0001');
      assert.equal(cancelledFailedRes.value.issueStatus, 'cancelled');
      assert.equal(cancelledFailedRes.value.voided, true);
      assert.equal(cancelledFailedRes.value.uploaded, true);
      assert.equal(
        cancelledFailedRes.value.uploadedDateTime,
        '2026-10-15 12:00:00',
      );
      assert.equal(cancelledFailedRes.value.turnkeyStatus, 'failed');
    }

    // Echo mismatches and required/malformed fields for getIssue
    assert.deepEqual(
      parseGetIssueResponse(
        makeEnvelope({
          ...fullGetIssuePayload,
          IIS_Relate_Number: 'I0200000000000000999',
        }),
        stageKeys,
        {
          merchantId,
          by: 'relate_number',
          relateNumber: B2C_INVOICE_SYNTHETIC_RELATE_NUMBER,
        },
      ),
      {
        kind: 'unknown',
        reason: 'relate_number_mismatch',
        field: 'IIS_Relate_Number',
      },
    );
    assert.deepEqual(
      parseGetIssueResponse(
        makeEnvelope({ ...fullGetIssuePayload, IIS_Number: 'CD87654321' }),
        stageKeys,
        {
          merchantId,
          by: 'invoice_no',
          invoiceNo: B2C_INVOICE_SYNTHETIC_INVOICE_NO,
        },
      ),
      { kind: 'unknown', reason: 'invoice_no_mismatch', field: 'IIS_Number' },
    );
    for (const field of [
      'IIS_Number',
      'IIS_Relate_Number',
      'IIS_Create_Date',
      'IIS_Issue_Status',
      'IIS_Invalid_Status',
      'IIS_Upload_Status',
      'IIS_Upload_Date',
      'IIS_Turnkey_Status',
      'IIS_Sales_Amount',
      'IIS_Remain_Allowance_Amt',
      'IIS_Random_Number',
    ]) {
      assert.deepEqual(
        parseGetIssueResponse(
          makeEnvelope({ ...fullGetIssuePayload, [field]: undefined }),
          stageKeys,
          {
            merchantId,
            by: 'relate_number',
            relateNumber: B2C_INVOICE_SYNTHETIC_RELATE_NUMBER,
          },
        ),
        { kind: 'unknown', reason: 'missing_field', field },
      );
      assert.deepEqual(
        parseGetIssueResponse(
          makeEnvelope({ ...fullGetIssuePayload, [field]: ' invalid ' }),
          stageKeys,
          {
            merchantId,
            by: 'relate_number',
            relateNumber: B2C_INVOICE_SYNTHETIC_RELATE_NUMBER,
          },
        ),
        { kind: 'unknown', reason: 'invalid_field', field },
      );
    }

    // getAllowanceList: 2 entries + PII check + [] + missing + object + mismatch at index 1
    const allowanceEntry1 = {
      IA_Allow_No: '2026101500000001',
      IA_Invoice_No: B2C_INVOICE_SYNTHETIC_INVOICE_NO,
      IA_Date: '2026-10-16 11:22:33',
      IA_Invalid_Status: '0',
      IA_Upload_Status: '1',
      IA_Upload_Date: '2026-10-16 12:00:00',
      IA_Total_Tax_Amount: 500,
      IA_Send_Mail: 'pii-secret@example.test',
      IA_Send_Phone: '0911222333',
      IIS_Customer_Name: '王小明',
      IA_IP: '203.0.113.42',
      IA_Identifier: '97025978',
      Items: [{ ItemName: '機密商品名稱' }],
    };
    const allowanceEntry2 = {
      ...allowanceEntry1,
      IA_Allow_No: '2026101500000002',
      IA_Invalid_Status: '1',
      IA_Upload_Status: '0',
      IA_Upload_Date: '',
      IA_Total_Tax_Amount: '300',
    };

    const twoAllowancesRes = parseGetAllowanceListResponse(
      makeEnvelope({
        RtnCode: 1,
        RtnMsg: 'ok',
        AllowanceInfo: [allowanceEntry1, allowanceEntry2],
      }),
      stageKeys,
      { merchantId, invoiceNo: B2C_INVOICE_SYNTHETIC_INVOICE_NO },
    );
    assertDeepFrozen(twoAllowancesRes);
    assert.deepEqual(twoAllowancesRes, {
      kind: 'ok',
      value: {
        allowances: [
          {
            allowanceNo: '2026101500000001',
            invoiceNo: B2C_INVOICE_SYNTHETIC_INVOICE_NO,
            allowanceDateTime: '2026-10-16 11:22:33',
            allowanceAtEpochMs: 1792120953000,
            voided: false,
            uploaded: true,
            uploadedDateTime: '2026-10-16 12:00:00',
            uploadedAtEpochMs: 1792123200000,
            amountMinor: 50000,
          },
          {
            allowanceNo: '2026101500000002',
            invoiceNo: B2C_INVOICE_SYNTHETIC_INVOICE_NO,
            allowanceDateTime: '2026-10-16 11:22:33',
            allowanceAtEpochMs: 1792120953000,
            voided: true,
            uploaded: false,
            uploadedDateTime: null,
            uploadedAtEpochMs: null,
            amountMinor: 30000,
          },
        ],
      },
    });
    const serializedAllowances = JSON.stringify(twoAllowancesRes);
    for (const marker of piiMarkers) {
      assert.equal(serializedAllowances.includes(marker), false);
    }

    assert.deepEqual(
      parseGetAllowanceListResponse(
        makeEnvelope({ RtnCode: 1, RtnMsg: 'ok', AllowanceInfo: [] }),
        stageKeys,
        { merchantId, invoiceNo: B2C_INVOICE_SYNTHETIC_INVOICE_NO },
      ),
      { kind: 'ok', value: { allowances: [] } },
    );
    assert.deepEqual(
      parseGetAllowanceListResponse(
        makeEnvelope({ RtnCode: 1, RtnMsg: 'ok' }),
        stageKeys,
        { merchantId, invoiceNo: B2C_INVOICE_SYNTHETIC_INVOICE_NO },
      ),
      { kind: 'unknown', reason: 'missing_field', field: 'AllowanceInfo' },
    );
    assert.deepEqual(
      parseGetAllowanceListResponse(
        makeEnvelope({ RtnCode: 1, RtnMsg: 'ok', AllowanceInfo: {} }),
        stageKeys,
        { merchantId, invoiceNo: B2C_INVOICE_SYNTHETIC_INVOICE_NO },
      ),
      { kind: 'unknown', reason: 'invalid_field', field: 'AllowanceInfo' },
    );
    assert.deepEqual(
      parseGetAllowanceListResponse(
        makeEnvelope({
          RtnCode: 1,
          RtnMsg: 'ok',
          AllowanceInfo: [
            allowanceEntry1,
            { ...allowanceEntry2, IA_Invoice_No: 'CD87654321' },
          ],
        }),
        stageKeys,
        { merchantId, invoiceNo: B2C_INVOICE_SYNTHETIC_INVOICE_NO },
      ),
      {
        kind: 'unknown',
        reason: 'invoice_no_mismatch',
        field: 'AllowanceInfo[1].IA_Invoice_No',
      },
    );

    for (const field of [
      'IA_Allow_No',
      'IA_Invoice_No',
      'IA_Date',
      'IA_Invalid_Status',
      'IA_Upload_Status',
      'IA_Upload_Date',
      'IA_Total_Tax_Amount',
    ]) {
      assert.deepEqual(
        parseGetAllowanceListResponse(
          makeEnvelope({
            RtnCode: 1,
            RtnMsg: 'ok',
            AllowanceInfo: [{ ...allowanceEntry1, [field]: undefined }],
          }),
          stageKeys,
          { merchantId, invoiceNo: B2C_INVOICE_SYNTHETIC_INVOICE_NO },
        ),
        {
          kind: 'unknown',
          reason: 'missing_field',
          field: `AllowanceInfo[0].${field}`,
        },
      );
      assert.deepEqual(
        parseGetAllowanceListResponse(
          makeEnvelope({
            RtnCode: 1,
            RtnMsg: 'ok',
            AllowanceInfo: [{ ...allowanceEntry1, [field]: 'bad-val' }],
          }),
          stageKeys,
          { merchantId, invoiceNo: B2C_INVOICE_SYNTHETIC_INVOICE_NO },
        ),
        {
          kind: 'unknown',
          reason: 'invalid_field',
          field: `AllowanceInfo[0].${field}`,
        },
      );
    }
    assert.deepEqual(
      parseGetAllowanceListResponse(
        makeEnvelope({
          RtnCode: 1,
          RtnMsg: 'ok',
          AllowanceInfo: [
            { ...allowanceEntry1, IA_Allow_No: '2026101500000099' },
          ],
        }),
        stageKeys,
        { merchantId, allowanceNo: '2026101500000001' },
      ),
      {
        kind: 'unknown',
        reason: 'allowance_no_mismatch',
        field: 'AllowanceInfo[0].IA_Allow_No',
      },
    );

    // getInvalid + PII check
    const baseInvalidPayload = {
      RtnCode: 1,
      RtnMsg: 'ok',
      II_Invoice_No: B2C_INVOICE_SYNTHETIC_INVOICE_NO,
      II_Date: '2026-10-16 09:00:00',
      II_Upload_Status: '0',
      II_Upload_Date: '',
      II_Buyer_Identifier: '97025978',
    };
    const invalidRes = parseGetInvalidResponse(
      makeEnvelope(baseInvalidPayload),
      stageKeys,
      { merchantId, invoiceNo: B2C_INVOICE_SYNTHETIC_INVOICE_NO },
    );
    assertDeepFrozen(invalidRes);
    assert.deepEqual(invalidRes, {
      kind: 'ok',
      value: {
        invoiceNo: B2C_INVOICE_SYNTHETIC_INVOICE_NO,
        voidedDateTime: '2026-10-16 09:00:00',
        voidedAtEpochMs: 1792112400000,
        uploaded: false,
        uploadedDateTime: null,
        uploadedAtEpochMs: null,
      },
    });
    assert.equal(JSON.stringify(invalidRes).includes('97025978'), false);
    assert.deepEqual(
      parseGetInvalidResponse(
        makeEnvelope({ ...baseInvalidPayload, II_Invoice_No: 'CD87654321' }),
        stageKeys,
        { merchantId, invoiceNo: B2C_INVOICE_SYNTHETIC_INVOICE_NO },
      ),
      {
        kind: 'unknown',
        reason: 'invoice_no_mismatch',
        field: 'II_Invoice_No',
      },
    );
    for (const field of [
      'II_Invoice_No',
      'II_Date',
      'II_Upload_Status',
      'II_Upload_Date',
    ]) {
      assert.deepEqual(
        parseGetInvalidResponse(
          makeEnvelope({ ...baseInvalidPayload, [field]: undefined }),
          stageKeys,
          { merchantId, invoiceNo: B2C_INVOICE_SYNTHETIC_INVOICE_NO },
        ),
        { kind: 'unknown', reason: 'missing_field', field },
      );
      assert.deepEqual(
        parseGetInvalidResponse(
          makeEnvelope({ ...baseInvalidPayload, [field]: 'bad-val' }),
          stageKeys,
          { merchantId, invoiceNo: B2C_INVOICE_SYNTHETIC_INVOICE_NO },
        ),
        { kind: 'unknown', reason: 'invalid_field', field },
      );
    }

    // getAllowanceInvalid + PII check
    const baseAllowInvalidPayload = {
      RtnCode: 1,
      RtnMsg: 'ok',
      AI_Allow_No: B2C_INVOICE_SYNTHETIC_ALLOWANCE_NO,
      AI_Invoice_No: B2C_INVOICE_SYNTHETIC_INVOICE_NO,
      AI_Date: '2026-10-17 09:00:00',
      AI_Upload_Status: '1',
      AI_Upload_Date: '2026-10-17 10:00:00',
      AI_Buyer_Identifier: '97025978',
    };
    const allowInvalidRes = parseGetAllowanceInvalidResponse(
      makeEnvelope(baseAllowInvalidPayload),
      stageKeys,
      {
        merchantId,
        invoiceNo: B2C_INVOICE_SYNTHETIC_INVOICE_NO,
        allowanceNo: B2C_INVOICE_SYNTHETIC_ALLOWANCE_NO,
      },
    );
    assertDeepFrozen(allowInvalidRes);
    assert.deepEqual(allowInvalidRes, {
      kind: 'ok',
      value: {
        allowanceNo: B2C_INVOICE_SYNTHETIC_ALLOWANCE_NO,
        invoiceNo: B2C_INVOICE_SYNTHETIC_INVOICE_NO,
        voidedDateTime: '2026-10-17 09:00:00',
        voidedAtEpochMs: 1792198800000,
        uploaded: true,
        uploadedDateTime: '2026-10-17 10:00:00',
        uploadedAtEpochMs: 1792202400000,
      },
    });
    assert.equal(JSON.stringify(allowInvalidRes).includes('97025978'), false);
    assert.deepEqual(
      parseGetAllowanceInvalidResponse(
        makeEnvelope({
          ...baseAllowInvalidPayload,
          AI_Allow_No: '2026101500000099',
        }),
        stageKeys,
        {
          merchantId,
          invoiceNo: B2C_INVOICE_SYNTHETIC_INVOICE_NO,
          allowanceNo: B2C_INVOICE_SYNTHETIC_ALLOWANCE_NO,
        },
      ),
      {
        kind: 'unknown',
        reason: 'allowance_no_mismatch',
        field: 'AI_Allow_No',
      },
    );
    assert.deepEqual(
      parseGetAllowanceInvalidResponse(
        makeEnvelope({
          ...baseAllowInvalidPayload,
          AI_Invoice_No: 'CD87654321',
        }),
        stageKeys,
        {
          merchantId,
          invoiceNo: B2C_INVOICE_SYNTHETIC_INVOICE_NO,
          allowanceNo: B2C_INVOICE_SYNTHETIC_ALLOWANCE_NO,
        },
      ),
      {
        kind: 'unknown',
        reason: 'invoice_no_mismatch',
        field: 'AI_Invoice_No',
      },
    );
    for (const field of [
      'AI_Allow_No',
      'AI_Invoice_No',
      'AI_Date',
      'AI_Upload_Status',
      'AI_Upload_Date',
    ]) {
      assert.deepEqual(
        parseGetAllowanceInvalidResponse(
          makeEnvelope({ ...baseAllowInvalidPayload, [field]: undefined }),
          stageKeys,
          {
            merchantId,
            invoiceNo: B2C_INVOICE_SYNTHETIC_INVOICE_NO,
            allowanceNo: B2C_INVOICE_SYNTHETIC_ALLOWANCE_NO,
          },
        ),
        { kind: 'unknown', reason: 'missing_field', field },
      );
      assert.deepEqual(
        parseGetAllowanceInvalidResponse(
          makeEnvelope({ ...baseAllowInvalidPayload, [field]: 'bad-val' }),
          stageKeys,
          {
            merchantId,
            invoiceNo: B2C_INVOICE_SYNTHETIC_INVOICE_NO,
            allowanceNo: B2C_INVOICE_SYNTHETIC_ALLOWANCE_NO,
          },
        ),
        { kind: 'unknown', reason: 'invalid_field', field },
      );
    }
  });

  it('parses word tracks (array of two, single object, empty array, empty InvoiceNo) and computes wordTrackRemaining', () => {
    const merchantId = B2C_INVOICE_MERCHANT_ID;
    const rawTrack1 = {
      TrackID: '1001',
      InvoiceYear: '115',
      InvoiceTerm: 5,
      InvoiceCategory: 1,
      InvType: '07',
      InvoiceHeader: 'AB',
      InvoiceStart: '10000000',
      InvoiceEnd: '10000049',
      InvoiceNo: '10000010',
      UseStatus: 2,
    };
    const rawTrack2 = {
      TrackID: '1002',
      InvoiceYear: '115',
      InvoiceTerm: '6',
      InvoiceCategory: 1,
      InvType: '08',
      ProductServiceId: 'PS1',
      InvoiceHeader: 'CD',
      InvoiceStart: '20000000',
      InvoiceEnd: '20000049',
      InvoiceNo: '',
      UseStatus: '1',
    };

    const twoTracksRes = parseWordSettingResponse(
      makeEnvelope({
        RtnCode: 1,
        RtnMsg: 'ok',
        InvoiceInfo: [rawTrack1, rawTrack2],
      }),
      stageKeys,
      { merchantId },
    );
    assertDeepFrozen(twoTracksRes);
    assert.deepEqual(twoTracksRes, {
      kind: 'ok',
      value: {
        tracks: [
          {
            trackId: '1001',
            invoiceYear: '115',
            invoiceTerm: 5,
            invType: '07',
            header: 'AB',
            start: '10000000',
            end: '10000049',
            lastUsed: '10000010',
            useStatus: 2,
          },
          {
            trackId: '1002',
            invoiceYear: '115',
            invoiceTerm: 6,
            invType: '08',
            header: 'CD',
            start: '20000000',
            end: '20000049',
            lastUsed: null,
            useStatus: 1,
          },
        ],
      },
    });

    const singleObjectRes = parseWordSettingResponse(
      makeEnvelope({
        RtnCode: 1,
        RtnMsg: 'ok',
        InvoiceInfo: rawTrack1,
      }),
      stageKeys,
      { merchantId },
    );
    assert.deepEqual(singleObjectRes, {
      kind: 'ok',
      value: {
        tracks: [
          {
            trackId: '1001',
            invoiceYear: '115',
            invoiceTerm: 5,
            invType: '07',
            header: 'AB',
            start: '10000000',
            end: '10000049',
            lastUsed: '10000010',
            useStatus: 2,
          },
        ],
      },
    });

    const emptyArrayRes = parseWordSettingResponse(
      makeEnvelope({ RtnCode: 1, RtnMsg: 'ok', InvoiceInfo: [] }),
      stageKeys,
      { merchantId },
    );
    assert.deepEqual(emptyArrayRes, { kind: 'ok', value: { tracks: [] } });

    assert.deepEqual(
      parseWordSettingResponse(
        makeEnvelope({ RtnCode: 1, RtnMsg: 'ok' }),
        stageKeys,
        { merchantId },
      ),
      { kind: 'unknown', reason: 'missing_field', field: 'InvoiceInfo' },
    );
    assert.deepEqual(
      parseWordSettingResponse(
        makeEnvelope({
          RtnCode: 1,
          RtnMsg: 'ok',
          InvoiceInfo: [{ ...rawTrack1, InvoiceEnd: '09999999' }],
        }),
        stageKeys,
        { merchantId },
      ),
      {
        kind: 'unknown',
        reason: 'invalid_field',
        field: 'InvoiceInfo[0].InvoiceEnd',
      },
    );
    for (const field of [
      'TrackID',
      'InvoiceYear',
      'InvoiceTerm',
      'InvType',
      'InvoiceHeader',
      'InvoiceStart',
      'InvoiceEnd',
      'UseStatus',
    ]) {
      assert.deepEqual(
        parseWordSettingResponse(
          makeEnvelope({
            RtnCode: 1,
            RtnMsg: 'ok',
            InvoiceInfo: [{ ...rawTrack1, [field]: undefined }],
          }),
          stageKeys,
          { merchantId },
        ),
        {
          kind: 'unknown',
          reason: 'missing_field',
          field: `InvoiceInfo[0].${field}`,
        },
      );
      assert.deepEqual(
        parseWordSettingResponse(
          makeEnvelope({
            RtnCode: 1,
            RtnMsg: 'ok',
            InvoiceInfo: [{ ...rawTrack1, [field]: '!!!bad!!!' }],
          }),
          stageKeys,
          { merchantId },
        ),
        {
          kind: 'unknown',
          reason: 'invalid_field',
          field: `InvoiceInfo[0].${field}`,
        },
      );
    }
    assert.deepEqual(
      parseWordSettingResponse(
        makeEnvelope({
          RtnCode: 1,
          RtnMsg: 'ok',
          InvoiceInfo: [{ ...rawTrack1, InvoiceNo: 'bad' }],
        }),
        stageKeys,
        { merchantId },
      ),
      {
        kind: 'unknown',
        reason: 'invalid_field',
        field: 'InvoiceInfo[0].InvoiceNo',
      },
    );

    const baseTrack: WordTrack = {
      trackId: '1001',
      invoiceYear: '115',
      invoiceTerm: 5,
      invType: '07',
      header: 'AB',
      start: '10000000',
      end: '10000049',
      lastUsed: '10000010',
      useStatus: 2,
    };
    assert.equal(wordTrackRemaining(baseTrack), 39);
    assert.equal(
      wordTrackRemaining({ ...baseTrack, lastUsed: '10000049' }),
      0,
    );
    assert.equal(wordTrackRemaining({ ...baseTrack, lastUsed: null }), null);
    assert.equal(
      wordTrackRemaining({ ...baseTrack, lastUsed: '09999999' }),
      null,
    );
    assert.equal(
      wordTrackRemaining({ ...baseTrack, lastUsed: '10000050' }),
      null,
    );
  });

  it('parses and classifies barcode, love-code, and company-name lookups and HTTP status codes', () => {
    const merchantId = B2C_INVOICE_MERCHANT_ID;

    // Barcode lookup
    const barcodeY = parseCheckBarcodeResponse(
      makeEnvelope({ RtnCode: 1, RtnMsg: 'ok', IsExist: 'Y' }),
      stageKeys,
      { merchantId },
    );
    const barcodeN = parseCheckBarcodeResponse(
      makeEnvelope({ RtnCode: 1, RtnMsg: 'ok', IsExist: 'N' }),
      stageKeys,
      { merchantId },
    );
    const barcodeOther = parseCheckBarcodeResponse(
      makeEnvelope({ RtnCode: 1, RtnMsg: 'ok', IsExist: 'X' }),
      stageKeys,
      { merchantId },
    );
    assert.deepEqual(barcodeY, { kind: 'ok', value: { exists: true } });
    assert.deepEqual(barcodeN, { kind: 'ok', value: { exists: false } });
    assert.deepEqual(barcodeOther, {
      kind: 'unknown',
      reason: 'invalid_field',
      field: 'IsExist',
    });
    assert.deepEqual(
      parseCheckBarcodeResponse(
        makeEnvelope({ RtnCode: 1, RtnMsg: 'ok', IsExist: '' }),
        stageKeys,
        { merchantId },
      ),
      { kind: 'unknown', reason: 'missing_field', field: 'IsExist' },
    );
    assert.equal(classifyBarcodeCheck(barcodeY), 'valid');
    assert.equal(classifyBarcodeCheck(barcodeN), 'invalid');
    assert.equal(classifyBarcodeCheck(barcodeOther), 'indeterminate');

    // LoveCode lookup
    const loveY = parseCheckLoveCodeResponse(
      makeEnvelope({
        RtnCode: 1,
        RtnMsg: 'ok',
        IsExist: 'Y',
        OrganName: '合成公益基金會',
      }),
      stageKeys,
      { merchantId },
    );
    const loveN = parseCheckLoveCodeResponse(
      makeEnvelope({ RtnCode: 1, RtnMsg: 'ok', IsExist: 'N', OrganName: '' }),
      stageKeys,
      { merchantId },
    );
    assert.deepEqual(loveY, {
      kind: 'ok',
      value: { exists: true, organName: '合成公益基金會' },
    });
    assert.deepEqual(loveN, {
      kind: 'ok',
      value: { exists: false, organName: null },
    });
    assert.deepEqual(
      parseCheckLoveCodeResponse(
        makeEnvelope({ RtnCode: 1, RtnMsg: 'ok', IsExist: '' }),
        stageKeys,
        { merchantId },
      ),
      { kind: 'unknown', reason: 'missing_field', field: 'IsExist' },
    );
    assert.deepEqual(
      parseCheckLoveCodeResponse(
        makeEnvelope({ RtnCode: 1, RtnMsg: 'ok', IsExist: 'Y', OrganName: 123 }),
        stageKeys,
        { merchantId },
      ),
      { kind: 'unknown', reason: 'invalid_field', field: 'OrganName' },
    );
    assert.equal(classifyLoveCodeCheck(loveY), 'valid');
    assert.equal(classifyLoveCodeCheck(loveN), 'invalid');
    assert.equal(
      classifyLoveCodeCheck({
        kind: 'not_accepted',
        transCode: '0',
        transMsg: 'err',
      }),
      'indeterminate',
    );

    // Company name lookup & classifier
    const companyOk = parseCompanyNameResponse(
      makeEnvelope({
        RtnCode: 1,
        RtnMsg: 'ok',
        CompanyName: '綠界科技股份有限公司',
      }),
      stageKeys,
      { merchantId },
    );
    assert.deepEqual(companyOk, {
      kind: 'ok',
      value: { companyName: '綠界科技股份有限公司' },
    });
    assert.deepEqual(
      parseCompanyNameResponse(
        makeEnvelope({ RtnCode: 1, RtnMsg: 'ok', CompanyName: '' }),
        stageKeys,
        { merchantId },
      ),
      { kind: 'unknown', reason: 'missing_field', field: 'CompanyName' },
    );
    assert.deepEqual(
      parseCompanyNameResponse(
        makeEnvelope({ RtnCode: 1, RtnMsg: 'ok', CompanyName: 123 }),
        stageKeys,
        { merchantId },
      ),
      { kind: 'unknown', reason: 'invalid_field', field: 'CompanyName' },
    );

    const classifiedFound = classifyCompanyNameCheck(companyOk);
    assertDeepFrozen(classifiedFound);
    assert.deepEqual(classifiedFound, {
      kind: 'found',
      companyName: '綠界科技股份有限公司',
    });

    for (const stopCode of ['1200125', '2027000']) {
      const res = classifyCompanyNameCheck({
        kind: 'rejected',
        rtnCode: stopCode,
        rtnMsg: '統編錯誤',
      });
      assertDeepFrozen(res);
      assert.deepEqual(res, { kind: 'invalid_ubn' });
    }
    for (const nonStopCode of ['7', '9000001']) {
      const res = classifyCompanyNameCheck({
        kind: 'rejected',
        rtnCode: nonStopCode,
        rtnMsg: '查無或系統異常',
      });
      assertDeepFrozen(res);
      assert.deepEqual(res, { kind: 'indeterminate' });
    }
    assert.deepEqual(
      classifyCompanyNameCheck({
        kind: 'not_accepted',
        transCode: '0',
        transMsg: 'err',
      }),
      { kind: 'indeterminate' },
    );
    assert.deepEqual(
      classifyCompanyNameCheck({ kind: 'unknown', reason: 'invalid_json' }),
      { kind: 'indeterminate' },
    );

    // classifyInvoiceHttpStatus
    assert.equal(classifyInvoiceHttpStatus(200), 'response');
    assert.equal(classifyInvoiceHttpStatus(403), 'throttled');
    for (const code of [201, 302, 404, 500, 502]) {
      assert.equal(classifyInvoiceHttpStatus(code), 'unknown');
    }
    for (const badStatus of [99, 600, 200.5, '200']) {
      expectProtocolError(() =>
        classifyInvoiceHttpStatus(badStatus as number),
      );
    }
  });

  it('verifies and parses the online-allowance consent callback vector, key rotation, Uint8Array body, and error cases', () => {
    const vector = CHECKMAC_VECTORS.find(
      (v) => v.id === 'invoice-allowance',
    )!;
    const body = encodeForm([
      ...vector.fields,
      ['CheckMacValue', vector.expectedMac],
    ]);
    const expectedSha256 = createHash('sha256')
      .update(body, 'utf8')
      .digest('hex');

    const consent = parseAllowanceConsentCallback(body, stageKeys);
    assertDeepFrozen(consent);
    assert.deepEqual(consent, {
      kind: 'consent',
      keyIndex: 0,
      allowanceNo: '1909181313013546',
      invoiceNo: 'UV11100019',
      allowanceDateTime: '2019-09-18 13:13:23',
      allowanceAtEpochMs: 1568783603000,
      remainingAllowanceMinor: 0,
      dedupe: {
        allowanceNo: '1909181313013546',
        rtnCode: '1',
      },
      bodySha256: expectedSha256,
    });
    assert.equal(JSON.stringify(consent).includes('折讓開立成功'), false);

    // Key rotation [otherKeys, stageKeys] -> keyIndex 1
    const rotated = parseAllowanceConsentCallback(body, [otherKeys, stageKeys]);
    assert.equal(rotated.kind, 'consent');
    if (rotated.kind === 'consent') {
      assert.equal(rotated.keyIndex, 1);
    }

    // Uint8Array body -> same result
    const bytesBody = new TextEncoder().encode(body);
    const fromBytes = parseAllowanceConsentCallback(bytesBody, stageKeys);
    assert.deepEqual(fromBytes, consent);

    // Tampered -> mac_mismatch
    const tamperedBody = body.replace('UV11100019', 'UV11100020');
    assert.deepEqual(parseAllowanceConsentCallback(tamperedBody, stageKeys), {
      kind: 'invalid',
      reason: 'mac_mismatch',
    });

    // Re-signed with RtnCode=0 -> unexpected_rtn_code
    const rtn0Body = signAllowanceForm(
      vector.fields.map(([k, v]) => (k === 'RtnCode' ? [k, '0'] : [k, v])),
    );
    assert.deepEqual(parseAllowanceConsentCallback(rtn0Body, stageKeys), {
      kind: 'invalid',
      reason: 'unexpected_rtn_code',
      field: 'RtnCode',
    });

    // Re-signed without IA_Allow_No -> missing_field
    const noAllowNoBody = signAllowanceForm(
      vector.fields.filter(([k]) => k !== 'IA_Allow_No'),
    );
    assert.deepEqual(parseAllowanceConsentCallback(noAllowNoBody, stageKeys), {
      kind: 'invalid',
      reason: 'missing_field',
      field: 'IA_Allow_No',
    });

    // 15-digit IA_Allow_No -> invalid_field
    const shortAllowNoBody = signAllowanceForm(
      vector.fields.map(([k, v]) =>
        k === 'IA_Allow_No' ? [k, '190918131301354'] : [k, v],
      ),
    );
    assert.deepEqual(
      parseAllowanceConsentCallback(shortAllowNoBody, stageKeys),
      {
        kind: 'invalid',
        reason: 'invalid_field',
        field: 'IA_Allow_No',
      },
    );

    // Unparseable IA_Date -> consent with both date fields null
    const badDateBody = signAllowanceForm(
      vector.fields.map(([k, v]) =>
        k === 'IA_Date' ? [k, 'not-a-date'] : [k, v],
      ),
    );
    const badDateRes = parseAllowanceConsentCallback(badDateBody, stageKeys);
    assert.equal(badDateRes.kind, 'consent');
    if (badDateRes.kind === 'consent') {
      assert.equal(badDateRes.allowanceDateTime, null);
      assert.equal(badDateRes.allowanceAtEpochMs, null);
    }

    // Duplicate field -> duplicate_field
    const duplicateBody = `${body}&RtnCode=1`;
    assert.deepEqual(parseAllowanceConsentCallback(duplicateBody, stageKeys), {
      kind: 'invalid',
      reason: 'duplicate_field',
    });
  });

  it('never leaks stage key strings, buyer data, or ciphertexts in any EcpayProtocolError message', () => {
    assert.ok(capturedErrors.length >= 40);

    const forbiddenSubstrings = [
      ...ALL_STAGE_KEY_STRINGS,
      B2C_INVOICE_SYNTHETIC_EMAIL,
      B2C_INVOICE_SYNTHETIC_BARCODE,
      B2C_INVOICE_SYNTHETIC_CERTIFICATE,
      B2C_INVOICE_SYNTHETIC_LOVE_CODE,
      B2C_INVOICE_SYNTHETIC_UBN,
      B2C_INVOICE_SYNTHETIC_COMPANY_TITLE,
      ...B2C_INVOICE_REQUEST_GOLDENS.map((g) => g.dataCipher),
    ];

    for (const err of capturedErrors) {
      for (const secret of forbiddenSubstrings) {
        assert.equal(
          err.message.includes(secret),
          false,
          `Error message leaked ${secret}: ${err.message}`,
        );
      }
    }
  });
});
