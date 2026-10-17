import {
  ECPAY_AIO_CREDIT_PROFILE,
  EcpayCreditCheckCode,
  buildCreditCheckoutForm,
  buildCreditDetailQuery,
  buildDoActionRequest,
  buildTradeInfoQuery,
  checkCreditAvailability,
  doActionWindow,
  formatTaipeiDateTime,
  nextDayCancelEarliest,
  parseCreditDetailResponse,
  parseDoActionResponse,
  parsePaymentBrowserReturn,
  parsePaymentNotification,
  parseTaipeiDateTime,
  parseTradeInfoResponse,
  planCreditRefund,
  type CreditSettlementStatus,
} from '../../../modules/agent-commerce/providers/ecpay/aio-credit/index.js';
import {
  EcpayKeyPair,
  aio,
  encodeForm,
  parseForm,
  type FormFields,
} from '../../../modules/agent-commerce/providers/ecpay/index.js';
import {
  AIO_CREDIT_GOLDEN_MERCHANT_ID,
  AIO_CREDIT_GOLDEN_TRADE_NO,
  CHECKOUT_GOLDEN_VECTORS,
  CREDIT_DETAIL_GOLDEN_VECTOR,
  DO_ACTION_GOLDEN_VECTOR,
  QUERY_GOLDEN_VECTOR,
} from './aio-credit-vectors.js';
import { CHECKMAC_VECTORS, STAGE_KEYS } from './vectors.js';

export interface AioCreditWorkerEvaluation {
  readonly profile: string;
  readonly availability: ReadonlyArray<{
    readonly id: string;
    readonly result: ReturnType<typeof checkCreditAvailability>;
  }>;
  readonly checkoutGoldens: ReadonlyArray<{
    readonly id: string;
    readonly action: string;
    readonly fields: FormFields;
    readonly mac: string;
    readonly encodedBody: string;
    readonly verifiedOk: boolean;
  }>;
  readonly queryGolden: {
    readonly url: string;
    readonly method: string;
    readonly contentType: string;
    readonly bodyText: string;
    readonly fields: FormFields;
    readonly mac: string;
    readonly verifiedOk: boolean;
    readonly redactedJson: unknown;
    readonly redactedString: string;
  };
  readonly doActionGolden: {
    readonly url: string;
    readonly method: string;
    readonly contentType: string;
    readonly bodyText: string;
    readonly fields: FormFields;
    readonly mac: string;
    readonly verifiedOk: boolean;
    readonly redactedJson: unknown;
    readonly redactedString: string;
  };
  readonly creditDetailGolden: {
    readonly url: string;
    readonly method: string;
    readonly contentType: string;
    readonly bodyText: string;
    readonly fields: FormFields;
    readonly mac: string;
    readonly verifiedOk: boolean;
    readonly redactedJson: unknown;
    readonly redactedString: string;
    readonly checkCodeJson: string;
    readonly checkCodeString: string;
  };
  readonly notifications: {
    readonly official2878: ReturnType<typeof parsePaymentNotification>;
    readonly official2878LowerTradeNo: ReturnType<typeof parsePaymentNotification>;
    readonly syntheticExtras: ReturnType<typeof parsePaymentNotification>;
    readonly browserReturn2878: ReturnType<typeof parsePaymentBrowserReturn>;
  };
  readonly queryResponses: {
    readonly paid: ReturnType<typeof parseTradeInfoResponse>;
    readonly unpaid: ReturnType<typeof parseTradeInfoResponse>;
    readonly failed: ReturnType<typeof parseTradeInfoResponse>;
    readonly amountMismatch: ReturnType<typeof parseTradeInfoResponse>;
    readonly tradeNoMismatch: ReturnType<typeof parseTradeInfoResponse>;
    readonly unknown: ReturnType<typeof parseTradeInfoResponse>;
  };
  readonly creditDetailResponses: {
    readonly detail: ReturnType<typeof parseCreditDetailResponse>;
    readonly error: ReturnType<typeof parseCreditDetailResponse>;
  };
  readonly refundTable: ReadonlyArray<{
    readonly id: string;
    readonly result: ReturnType<typeof planCreditRefund>;
  }>;
  readonly doActionResponses: {
    readonly succeeded: ReturnType<typeof parseDoActionResponse>;
    readonly rejected: ReturnType<typeof parseDoActionResponse>;
    readonly unknownEchoMismatch: ReturnType<typeof parseDoActionResponse>;
    readonly unknownUnparseable: ReturnType<typeof parseDoActionResponse>;
  };
  readonly timeHelpers: {
    readonly formattedGolden: string;
    readonly formattedMidnight: string;
    readonly formattedNewYear: string;
    readonly parsedGolden: number | null;
    readonly parsedInvalid: number | null;
    readonly windowBefore: ReturnType<typeof doActionWindow>;
    readonly windowDuring: ReturnType<typeof doActionWindow>;
    readonly windowAfter: ReturnType<typeof doActionWindow>;
    readonly nextDayCancelStart: number;
    readonly nextDayCancelEnd: number;
  };
}

export function evaluateAioCreditVectors(): AioCreditWorkerEvaluation {
  const keys = EcpayKeyPair.of(
    STAGE_KEYS.aio3002607.hashKey,
    STAGE_KEYS.aio3002607.hashIV,
  );
  const checkCode = EcpayCreditCheckCode.of(STAGE_KEYS.aio3002607.creditCheckCode);

  const availability = [
    {
      id: 'valid-500',
      result: checkCreditAvailability({
        currency: 'TWD',
        totalMinor: 500,
        amountsMinor: [500, 0],
      }),
    },
    {
      id: 'usd-with-odd',
      result: checkCreditAvailability({
        currency: 'USD',
        totalMinor: 150,
        amountsMinor: [150],
      }),
    },
    {
      id: 'odd-total',
      result: checkCreditAvailability({
        currency: 'TWD',
        totalMinor: 150050,
        amountsMinor: [150000],
      }),
    },
    {
      id: 'odd-line',
      result: checkCreditAvailability({
        currency: 'TWD',
        totalMinor: 150000,
        amountsMinor: [100000, 50],
      }),
    },
    {
      id: 'below-min',
      result: checkCreditAvailability({
        currency: 'TWD',
        totalMinor: 400,
        amountsMinor: [400],
      }),
    },
  ];

  const checkoutGoldens = CHECKOUT_GOLDEN_VECTORS.map((vec) => {
    const form = buildCreditCheckoutForm(vec.input, keys);
    const encodedBody = encodeForm(form.fields);
    const verified = aio.verify(encodedBody, keys);
    const mac = form.fields[form.fields.length - 1][1];
    return {
      id: vec.id,
      action: form.action,
      fields: form.fields,
      mac,
      encodedBody,
      verifiedOk: verified.ok,
    };
  });

  const queryReq = buildTradeInfoQuery(QUERY_GOLDEN_VECTOR.input, keys);
  const queryBody = queryReq.bodyText();
  const queryFields = parseForm(queryBody);
  const queryVerified = aio.verify(queryBody, keys);

  const doActionReq = buildDoActionRequest(DO_ACTION_GOLDEN_VECTOR.input, keys);
  const doActionBody = doActionReq.bodyText();
  const doActionFields = parseForm(doActionBody);
  const doActionVerified = aio.verify(doActionBody, keys);

  const creditDetailReq = buildCreditDetailQuery(
    CREDIT_DETAIL_GOLDEN_VECTOR.input,
    keys,
    checkCode,
  );
  const creditDetailBody = creditDetailReq.bodyText();
  const creditDetailFields = parseForm(creditDetailBody);
  const creditDetailVerified = aio.verify(creditDetailBody, keys);

  const aioReturnVec = CHECKMAC_VECTORS.find((v) => v.id === 'aio-return')!;
  const official2878Body = encodeForm([
    ...aioReturnVec.fields,
    ['CheckMacValue', aioReturnVec.expectedMac],
  ]);
  const official2878 = parsePaymentNotification(official2878Body, keys, {
    merchantId: AIO_CREDIT_GOLDEN_MERCHANT_ID,
  });

  const lowerTradeNoFields = aioReturnVec.fields.map(([k, v]) =>
    k === 'MerchantTradeNo' ? ([k, v.toLowerCase()] as const) : ([k, v] as const),
  );
  const official2878LowerBody = encodeForm([
    ...lowerTradeNoFields,
    ['CheckMacValue', aioReturnVec.expectedMac],
  ]);
  const official2878LowerTradeNo = parsePaymentNotification(
    official2878LowerBody,
    keys,
    { merchantId: AIO_CREDIT_GOLDEN_MERCHANT_ID },
  );

  const extrasBody = encodeForm(
    aio.sign(
      [
        ['MerchantID', AIO_CREDIT_GOLDEN_MERCHANT_ID],
        ['MerchantTradeNo', AIO_CREDIT_GOLDEN_TRADE_NO],
        ['StoreID', ''],
        ['RtnCode', '1'],
        ['RtnMsg', '交易成功'],
        ['TradeNo', '2610150902037371'],
        ['TradeAmt', '1500'],
        ['PaymentDate', '2026/10/15 09:02:05'],
        ['PaymentType', 'Credit_CreditCard'],
        ['PaymentTypeChargeFee', '30'],
        ['TradeDate', '2026/10/15 09:02:03'],
        ['SimulatePaid', '0'],
        ['CustomField1', 'secret1'],
        ['CustomField2', ''],
        ['CustomField3', ''],
        ['CustomField4', ''],
        ['gwsr', '11943021'],
        ['process_date', '2026/10/15 09:02:05'],
        ['auth_code', '777777'],
        ['amount', '1500'],
        ['stage', '0'],
        ['stast', '0'],
        ['staed', '0'],
        ['eci', '5'],
        ['card4no', '9876'],
        ['card6no', '431195'],
      ],
      keys,
    ),
  );
  const syntheticExtras = parsePaymentNotification(extrasBody, keys, {
    merchantId: AIO_CREDIT_GOLDEN_MERCHANT_ID,
  });

  const browserReturn2878 = parsePaymentBrowserReturn(official2878Body, keys, {
    merchantId: AIO_CREDIT_GOLDEN_MERCHANT_ID,
  });

  const signQueryBody = (fields: Readonly<Record<string, string>>): string =>
    encodeForm(aio.sign(fields, keys));

  const baseQueryFields = {
    MerchantID: AIO_CREDIT_GOLDEN_MERCHANT_ID,
    MerchantTradeNo: AIO_CREDIT_GOLDEN_TRADE_NO,
    StoreID: '',
    TradeNo: '2610150902037371',
    TradeAmt: '1500',
    PaymentDate: '2026/10/15 09:02:05',
    PaymentType: 'Credit_CreditCard',
    HandlingCharge: '27.5',
    PaymentTypeChargeFee: '30',
    TradeDate: '2026/10/15 09:02:03',
    TradeStatus: '1',
    ItemName: '合成小舖商品一批 x1',
    CustomField1: '',
    CustomField2: '',
    CustomField3: '',
    CustomField4: '',
  };

  const queryOptions = {
    merchantId: AIO_CREDIT_GOLDEN_MERCHANT_ID,
    merchantTradeNo: AIO_CREDIT_GOLDEN_TRADE_NO,
    expectedAmountMinor: 150000,
    expectedTradeNo: '2610150902037371',
  };

  const queryResponses = {
    paid: parseTradeInfoResponse(signQueryBody(baseQueryFields), keys, queryOptions),
    unpaid: parseTradeInfoResponse(
      signQueryBody({ ...baseQueryFields, TradeStatus: '0', PaymentDate: '' }),
      keys,
      queryOptions,
    ),
    failed: parseTradeInfoResponse(
      signQueryBody({ ...baseQueryFields, TradeStatus: '10200095', PaymentDate: '' }),
      keys,
      queryOptions,
    ),
    amountMismatch: parseTradeInfoResponse(
      signQueryBody({ ...baseQueryFields, TradeAmt: '1400' }),
      keys,
      queryOptions,
    ),
    tradeNoMismatch: parseTradeInfoResponse(
      signQueryBody({ ...baseQueryFields, TradeNo: '2610150902039999' }),
      keys,
      queryOptions,
    ),
    unknown: parseTradeInfoResponse(
      signQueryBody({ ...baseQueryFields, TradeStatus: '10200163' }),
      keys,
      queryOptions,
    ),
  };

  const creditDetailResponses = {
    detail: parseCreditDetailResponse(
      JSON.stringify({
        RtnMsg: '',
        RtnValue: {
          TradeID: '2610150902037371',
          amount: '1500',
          clsamt: '1500',
          authtime: '2026/10/15 09:02:05',
          status: '已關帳',
          close_data: [
            {
              status: '已關帳',
              sno: '1',
              amount: '1500',
              datetime: '2026/10/15 20:20:00',
            },
          ],
        },
      }),
      { expectedAmountMinor: 150000 },
    ),
    error: parseCreditDetailResponse(
      JSON.stringify({ RtnMsg: 'error_nopay', RtnValue: {} }),
      { expectedAmountMinor: 150000 },
    ),
  };

  const refundCases: ReadonlyArray<{
    readonly id: string;
    readonly status: CreditSettlementStatus;
    readonly paidMinor: number;
    readonly refundedMinor: number;
    readonly requestedMinor: number;
  }> = [
    { id: 'auth-full', status: 'authorized', paidMinor: 150000, refundedMinor: 0, requestedMinor: 150000 },
    { id: 'auth-partial-0', status: 'authorized', paidMinor: 150000, refundedMinor: 0, requestedMinor: 50000 },
    { id: 'auth-partial-500', status: 'authorized', paidMinor: 150000, refundedMinor: 50000, requestedMinor: 50000 },
    { id: 'cancel-full', status: 'capture_cancelled', paidMinor: 150000, refundedMinor: 0, requestedMinor: 150000 },
    { id: 'cancel-partial-0', status: 'capture_cancelled', paidMinor: 150000, refundedMinor: 0, requestedMinor: 50000 },
    { id: 'cancel-partial-500', status: 'capture_cancelled', paidMinor: 150000, refundedMinor: 50000, requestedMinor: 50000 },
    { id: 'pending-full', status: 'capture_pending', paidMinor: 150000, refundedMinor: 0, requestedMinor: 150000 },
    { id: 'pending-partial-0', status: 'capture_pending', paidMinor: 150000, refundedMinor: 0, requestedMinor: 50000 },
    { id: 'pending-partial-500', status: 'capture_pending', paidMinor: 150000, refundedMinor: 50000, requestedMinor: 50000 },
    { id: 'captured-full', status: 'captured', paidMinor: 150000, refundedMinor: 0, requestedMinor: 150000 },
    { id: 'captured-partial-0', status: 'captured', paidMinor: 150000, refundedMinor: 0, requestedMinor: 50000 },
    { id: 'captured-partial-500', status: 'captured', paidMinor: 150000, refundedMinor: 50000, requestedMinor: 50000 },
    { id: 'unauth', status: 'unauthorized', paidMinor: 150000, refundedMinor: 0, requestedMinor: 50000 },
    { id: 'voided', status: 'voided', paidMinor: 150000, refundedMinor: 0, requestedMinor: 50000 },
    { id: 'exceeds', status: 'captured', paidMinor: 150000, refundedMinor: 100000, requestedMinor: 60000 },
  ];

  const refundTable = refundCases.map((c) => ({
    id: c.id,
    result: planCreditRefund({
      status: c.status,
      paidMinor: c.paidMinor,
      refundedMinor: c.refundedMinor,
      requestedMinor: c.requestedMinor,
    }),
  }));

  const doActionOptions = {
    merchantId: AIO_CREDIT_GOLDEN_MERCHANT_ID,
    merchantTradeNo: AIO_CREDIT_GOLDEN_TRADE_NO,
    tradeNo: '2610150902037371',
  };

  const doActionResponses = {
    succeeded: parseDoActionResponse(
      'MerchantID=3002607&MerchantTradeNo=FVTPVXVR14D2PF2DBSQQ&TradeNo=2610150902037371&RtnCode=1&RtnMsg=OK\r\n',
      doActionOptions,
    ),
    rejected: parseDoActionResponse(
      'MerchantID=3002607&MerchantTradeNo=FVTPVXVR14D2PF2DBSQQ&TradeNo=2610150902037371&RtnCode=10300077&RtnMsg=餘額不足\r\n',
      doActionOptions,
    ),
    unknownEchoMismatch: parseDoActionResponse(
      'MerchantID=3002607&MerchantTradeNo=FVTPVXVR14D2PF2DBSQQ&TradeNo=9999999999999999&RtnCode=1&RtnMsg=OK',
      doActionOptions,
    ),
    unknownUnparseable: parseDoActionResponse(
      '<html>502 Bad Gateway</html>',
      doActionOptions,
    ),
  };

  // Taipei 2026/10/15 20:14:59.999 = UTC 2026-10-15 12:14:59.999
  const taipei201459999 = Date.UTC(2026, 9, 15, 12, 14, 59, 999);
  const taipei201500000 = Date.UTC(2026, 9, 15, 12, 15, 0, 0);
  const taipei203100000 = Date.UTC(2026, 9, 15, 12, 31, 0, 0);

  // Taipei 2026/10/15 00:00:01 and 23:59:59
  const taipeiDayStart = Date.UTC(2026, 9, 14, 16, 0, 1, 0);
  const taipeiDayEnd = Date.UTC(2026, 9, 15, 15, 59, 59, 0);

  return {
    profile: ECPAY_AIO_CREDIT_PROFILE,
    availability,
    checkoutGoldens,
    queryGolden: {
      url: queryReq.url,
      method: queryReq.method,
      contentType: queryReq.contentType,
      bodyText: queryBody,
      fields: queryFields,
      mac: queryFields[queryFields.length - 1][1],
      verifiedOk: queryVerified.ok,
      redactedJson: JSON.parse(JSON.stringify(queryReq)),
      redactedString: String(queryReq),
    },
    doActionGolden: {
      url: doActionReq.url,
      method: doActionReq.method,
      contentType: doActionReq.contentType,
      bodyText: doActionBody,
      fields: doActionFields,
      mac: doActionFields[doActionFields.length - 1][1],
      verifiedOk: doActionVerified.ok,
      redactedJson: JSON.parse(JSON.stringify(doActionReq)),
      redactedString: String(doActionReq),
    },
    creditDetailGolden: {
      url: creditDetailReq.url,
      method: creditDetailReq.method,
      contentType: creditDetailReq.contentType,
      bodyText: creditDetailBody,
      fields: creditDetailFields,
      mac: creditDetailFields[creditDetailFields.length - 1][1],
      verifiedOk: creditDetailVerified.ok,
      redactedJson: JSON.parse(JSON.stringify(creditDetailReq)),
      redactedString: String(creditDetailReq),
      checkCodeJson: JSON.stringify(checkCode),
      checkCodeString: String(checkCode),
    },
    notifications: {
      official2878,
      official2878LowerTradeNo,
      syntheticExtras,
      browserReturn2878,
    },
    queryResponses,
    creditDetailResponses,
    refundTable,
    doActionResponses,
    timeHelpers: {
      formattedGolden: formatTaipeiDateTime(1792026123000),
      formattedMidnight: formatTaipeiDateTime(1791995400000),
      formattedNewYear: formatTaipeiDateTime(1798732800000),
      parsedGolden: parseTaipeiDateTime('2026/10/15 09:02:03'),
      parsedInvalid: parseTaipeiDateTime('2023/02/29 00:00:00'),
      windowBefore: doActionWindow(taipei201459999),
      windowDuring: doActionWindow(taipei201500000),
      windowAfter: doActionWindow(taipei203100000),
      nextDayCancelStart: nextDayCancelEarliest(taipeiDayStart),
      nextDayCancelEnd: nextDayCancelEarliest(taipeiDayEnd),
    },
  };
}

export default {
  async fetch(): Promise<Response> {
    const payload = evaluateAioCreditVectors();
    return Response.json(payload);
  },
};
