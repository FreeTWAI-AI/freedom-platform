/**
 * Official ECPay public stage test keys and protocol test vectors.
 *
 * All credentials in this file are ECPay's published public stage/sandbox test keys
 * from official developer documentation (`https://developers.ecpay.com.tw/<page>/`):
 * - AIO Payment (3002607): pages 2856, 2902, 2878
 * - AIO CVS / Domestic Logistics B2C & Omni (2000132): pages 2881, 7418, 10205
 * - Domestic Logistics C2C (2000933): page 7424
 * - B2C E-Invoice (2000132): pages 7958, 38242
 */

import type { CheckMacAlgorithm, FormFields } from '../../../modules/agent-commerce/providers/ecpay/index.js';

export interface StageKeySpec {
  readonly merchantId: string;
  readonly hashKey: string;
  readonly hashIV: string;
  readonly creditCheckCode?: string;
  readonly sourcePages: readonly number[];
}

export const STAGE_KEYS = Object.freeze({
  aio3002607: Object.freeze({
    merchantId: '3002607',
    hashKey: 'pwFHCqoQZGmho4w6',
    hashIV: 'EkRm7iFT261dpevs',
    creditCheckCode: '79470253',
    sourcePages: Object.freeze([2856, 2902, 2878]),
  }),
  shared2000132: Object.freeze({
    merchantId: '2000132',
    hashKey: '5294y06JbISpM5x9',
    hashIV: 'v77hoKGq4kWxNNIS',
    sourcePages: Object.freeze([2881, 7418, 10205]),
  }),
  logisticsC2c2000933: Object.freeze({
    merchantId: '2000933',
    hashKey: 'XBERn1YOvpM9nfZc',
    hashIV: 'h1ONHk4P4yqbl5LK',
    sourcePages: Object.freeze([7424]),
  }),
  invoice2000132: Object.freeze({
    merchantId: '2000132',
    hashKey: 'ejCk326UnaZWKisg',
    hashIV: 'q9jcZX8Ib9LM8wYk',
    sourcePages: Object.freeze([7958, 38242]),
  }),
} satisfies Record<string, StageKeySpec>);

export const ALL_STAGE_KEY_STRINGS: readonly string[] = Object.freeze([
  STAGE_KEYS.aio3002607.hashKey,
  STAGE_KEYS.aio3002607.hashIV,
  STAGE_KEYS.shared2000132.hashKey,
  STAGE_KEYS.shared2000132.hashIV,
  STAGE_KEYS.logisticsC2c2000933.hashKey,
  STAGE_KEYS.logisticsC2c2000933.hashIV,
  STAGE_KEYS.invoice2000132.hashKey,
  STAGE_KEYS.invoice2000132.hashIV,
  STAGE_KEYS.aio3002607.creditCheckCode,
]);

export interface CheckMacVector {
  readonly id:
    | 'aio-checkout'
    | 'aio-return'
    | 'aio-cvs-info'
    | 'logistics-create'
    | 'logistics-query'
    | 'logistics-query-v5'
    | 'invoice-allowance';
  readonly sourcePage: number;
  readonly keys: StageKeySpec;
  readonly algorithm: CheckMacAlgorithm;
  readonly fields: FormFields;
  readonly expectedMac: string;
  readonly staleDocMac?: string;
}

export const AIO_CHECKOUT_2902_INTERMEDIATE = Object.freeze({
  rawJoined:
    'HashKey=pwFHCqoQZGmho4w6&ChoosePayment=ALL&EncryptType=1&ItemName=Apple iphone 15&MerchantID=3002607&MerchantTradeDate=2023/03/12 15:30:23&MerchantTradeNo=ecpay20230312153023&PaymentType=aio&ReturnURL=https://www.ecpay.com.tw/receive.php&TotalAmount=30000&TradeDesc=促銷方案&HashIV=EkRm7iFT261dpevs',
  urlEncodedLower:
    'hashkey%3dpwfhcqoqzgmho4w6%26choosepayment%3dall%26encrypttype%3d1%26itemname%3dapple+iphone+15%26merchantid%3d3002607%26merchanttradedate%3d2023%2f03%2f12+15%3a30%3a23%26merchanttradeno%3decpay20230312153023%26paymenttype%3daio%26returnurl%3dhttps%3a%2f%2fwww.ecpay.com.tw%2freceive.php%26totalamount%3d30000%26tradedesc%3d%e4%bf%83%e9%8a%b7%e6%96%b9%e6%a1%88%26hashiv%3dekrm7ift261dpevs',
  expectedSha256: '6C51C9E6888DE861FD62FB1DD17029FC742634498FD813DC43D4243B5685B840',
});

const LOGISTICS_QUERY_BASE_FIELDS: FormFields = Object.freeze([
  ['ActualWeight', 'null'],
  ['AllPayLogisticsID', '1817824'],
  ['BookingNote', ''],
  ['CollectionAllocateAmount', '0'],
  ['CollectionAllocateDate', ''],
  ['CollectionAmount', '0'],
  ['CollectionChargeFee', '0'],
  ['CVSPaymentNo', ''],
  ['CVSValidationNo', ''],
  ['GoodsAmount', '1'],
  ['GoodsName', '測試商品'],
  ['GoodsWeight', 'null'],
  ['HandlingCharge', '52'],
  ['LogisticsStatus', '300'],
  ['LogisticsType', 'CVS_UNIMART'],
  ['MerchantID', '2000132'],
  ['MerchantTradeNo', '20211215142334754'],
  ['ShipChargeDate', ''],
  ['ShipmentNo', '82420218218'],
  ['TradeDate', '2021/12/15 14:23:34'],
]);

export const CHECKMAC_VECTORS: readonly CheckMacVector[] = Object.freeze([
  {
    id: 'aio-checkout',
    sourcePage: 2902,
    keys: STAGE_KEYS.aio3002607,
    algorithm: 'sha256',
    fields: Object.freeze<FormFields>([
      ['TradeDesc', '促銷方案'],
      ['PaymentType', 'aio'],
      ['MerchantTradeDate', '2023/03/12 15:30:23'],
      ['MerchantTradeNo', 'ecpay20230312153023'],
      ['MerchantID', '3002607'],
      ['ReturnURL', 'https://www.ecpay.com.tw/receive.php'],
      ['ItemName', 'Apple iphone 15'],
      ['TotalAmount', '30000'],
      ['ChoosePayment', 'ALL'],
      ['EncryptType', '1'],
    ]),
    expectedMac: '6C51C9E6888DE861FD62FB1DD17029FC742634498FD813DC43D4243B5685B840',
  },
  {
    id: 'aio-return',
    sourcePage: 2878,
    keys: STAGE_KEYS.aio3002607,
    algorithm: 'sha256',
    fields: Object.freeze<FormFields>([
      ['CustomField1', ''],
      ['CustomField2', ''],
      ['CustomField3', ''],
      ['CustomField4', ''],
      ['MerchantID', '3002607'],
      ['MerchantTradeNo', 'D9RMXNrihUYM'],
      ['PaymentDate', '2024/12/31 12:26:09'],
      ['PaymentType', 'Credit_CreditCard'],
      ['PaymentTypeChargeFee', '10'],
      ['RtnCode', '1'],
      ['RtnMsg', '交易成功'],
      ['SimulatePaid', '0'],
      ['StoreID', ''],
      ['TradeAmt', '402'],
      ['TradeDate', '2024/12/31 12:25:43'],
      ['TradeNo', '2412311225437371'],
    ]),
    expectedMac: '85D927637935683EA756CDEF76498FEB9F5D098A7A1AC4F0CB3B3609A9D4116A',
  },
  {
    id: 'aio-cvs-info',
    sourcePage: 2881,
    keys: STAGE_KEYS.shared2000132,
    algorithm: 'sha256',
    fields: Object.freeze<FormFields>([
      ['Barcode1', ''],
      ['Barcode2', ''],
      ['Barcode3', ''],
      ['ExpireDate', '2017/12/28 00:39:03'],
      ['MerchantID', '2000132'],
      ['MerchantTradeNo', 'Test1513787899'],
      ['PaymentNo', 'LLL17355880822'],
      ['PaymentType', 'CVS_CVS'],
      ['RtnCode', '10100073'],
      ['RtnMsg', 'Get CVS Code Succeeded.'],
      ['TradeAmt', '2000'],
      ['TradeDate', '2017/12/21 00:39:03'],
      ['TradeNo', '17122100383415923452'],
      ['StoreID', ''],
      ['CustomField1', ''],
      ['CustomField2', ''],
      ['CustomField3', ''],
      ['CustomField4', ''],
    ]),
    expectedMac: 'C25373CE6379BB6116FAE8398F4A8E60B71B289D955F6B8A9D9F53FDCC97F571',
  },
  {
    id: 'logistics-create',
    sourcePage: 7424,
    keys: STAGE_KEYS.logisticsC2c2000933,
    algorithm: 'md5',
    fields: Object.freeze<FormFields>([
      ['MerchantID', '2000933'],
      ['MerchantTradeNo', 'A20130312153023'],
      ['MerchantTradeDate', '2013/03/12 15:30:23'],
      ['LogisticsType', 'CVS'],
      ['LogisticsSubType', 'FAMIC2C'],
      ['GoodsAmount', '1000'],
      ['IsCollection', 'N'],
      ['ServerReplyURL', 'https://www.ecpay.com.tw/ServerReplyURL'],
      ['SenderName', '寄件者姓名'],
      ['ReceiverName', '收件者姓名'],
      ['ReceiverStoreID', '001779'],
    ]),
    expectedMac: '692FD6E2CDB539CCDB7206C76DC239AD',
  },
  {
    id: 'logistics-query',
    sourcePage: 7418,
    keys: STAGE_KEYS.shared2000132,
    algorithm: 'md5',
    fields: LOGISTICS_QUERY_BASE_FIELDS,
    expectedMac: 'B655FB0F67E8F89DB9DD997D19C3B62D',
  },
  {
    id: 'logistics-query-v5',
    sourcePage: 7418,
    keys: STAGE_KEYS.shared2000132,
    algorithm: 'md5',
    fields: Object.freeze<FormFields>([
      ...LOGISTICS_QUERY_BASE_FIELDS,
      ['SenderName', '王大明'],
      ['SenderPhone', '0222018909'],
      ['SenderCellPhone', '0987878787'],
    ]),
    expectedMac: '9FB2FDBE42AD47754F33CF85C3133E9C',
    staleDocMac: 'B655FB0F67E8F89DB9DD997D19C3B62D',
  },
  {
    id: 'invoice-allowance',
    sourcePage: 38242,
    keys: STAGE_KEYS.invoice2000132,
    algorithm: 'md5',
    fields: Object.freeze<FormFields>([
      ['RtnCode', '1'],
      ['RtnMsg', ''],
      ['IA_Allow_No', '1909181313013546'],
      ['IA_Invoice_No', 'UV11100019'],
      ['IA_Date', '2019-09-18 13:13:23'],
      ['IIS_Remain_Allowance_Amt', '0'],
    ]),
    expectedMac: '50A276E71DAE26343013958B405EEEA0',
  },
]);

export interface AesVector {
  readonly id:
    | 'invoice-aes-upper'
    | 'invoice-aes-lower'
    | 'omni-aes-upper'
    | 'omni-aes-lower';
  readonly sourcePage: number;
  readonly keys: StageKeySpec;
  readonly encodedCase: 'upper' | 'lower';
  readonly urlEncodedInput: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly expectedCiphertext: string;
}

export const AES_SAMPLE_PAYLOAD = Object.freeze({
  Name: 'Test',
  ID: 'A123456789',
});

export const AES_UPPER_URL_ENCODED =
  '%7B%22Name%22%3A%22Test%22%2C%22ID%22%3A%22A123456789%22%7D';
export const AES_LOWER_URL_ENCODED =
  '%7b%22Name%22%3a%22Test%22%2c%22ID%22%3a%22A123456789%22%7d';

export const AES_VECTORS: readonly AesVector[] = Object.freeze([
  {
    id: 'invoice-aes-upper',
    sourcePage: 7958,
    keys: STAGE_KEYS.invoice2000132,
    encodedCase: 'upper',
    urlEncodedInput: AES_UPPER_URL_ENCODED,
    payload: AES_SAMPLE_PAYLOAD,
    expectedCiphertext:
      'uvI4yrErM37XNQkXGAgRgJAgHn2t72jahaMZzYhWL1HmvH4WV18VJDP2i9pTbC+tby5nxVExLLFyAkbjbS2Dvg==',
  },
  {
    id: 'invoice-aes-lower',
    sourcePage: 7958,
    keys: STAGE_KEYS.invoice2000132,
    encodedCase: 'lower',
    urlEncodedInput: AES_LOWER_URL_ENCODED,
    payload: AES_SAMPLE_PAYLOAD,
    expectedCiphertext:
      'ZD/z07UvdmL3aYz0tsVo+bFXF5VldNcns6ezyfea777KOmLiizrUNDYe+v1bh2QTT4AySf1NICgXxWXB6f7c6A==',
  },
  {
    id: 'omni-aes-upper',
    sourcePage: 10205,
    keys: STAGE_KEYS.shared2000132,
    encodedCase: 'upper',
    urlEncodedInput: AES_UPPER_URL_ENCODED,
    payload: AES_SAMPLE_PAYLOAD,
    expectedCiphertext:
      '0FKSa0j4InjlU0ewoWpzd9FmU9LVR/8z9Zmh8d+shjJ8fuvlmNxsxyOQfC2BB4VVPEA/MyAHNjzV6HcAGYXgCw==',
  },
  {
    id: 'omni-aes-lower',
    sourcePage: 10205,
    keys: STAGE_KEYS.shared2000132,
    encodedCase: 'lower',
    urlEncodedInput: AES_LOWER_URL_ENCODED,
    payload: AES_SAMPLE_PAYLOAD,
    expectedCiphertext:
      'DjpiZjeCC4/aXLGmPQ3PB49xSmb9cEqQQjsl9I3aLBu6if9/yLIfeZOZGImD3MKcoYRge8zmB2OIYLzk1WjfGg==',
  },
]);

export interface TradeNumberVector {
  readonly id: string;
  readonly prefix: 'F' | 'L';
  readonly bytes: readonly number[];
  readonly expected: string;
}

export const TRADE_NUMBER_VECTORS: readonly TradeNumberVector[] = Object.freeze([
  {
    id: 'zeros',
    prefix: 'F',
    bytes: Object.freeze(new Array<number>(12).fill(0x00)),
    expected: 'F0000000000000000000',
  },
  {
    id: 'ones',
    prefix: 'F',
    bytes: Object.freeze(new Array<number>(12).fill(0xff)),
    expected: 'FZZZZZZZZZZZZZZZZZZZ',
  },
  {
    id: 'sequential',
    prefix: 'L',
    bytes: Object.freeze([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
    expected: 'L000G40R40M30E209185',
  },
  {
    id: 'deadbeef',
    prefix: 'F',
    bytes: Object.freeze([
      0xde, 0xad, 0xbe, 0xef, 0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef,
    ]),
    expected: 'FVTPVXVR14D2PF2DBSQQ',
  },
]);

export const DOTNET_URL_ENCODE_TABLE: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ['-', '-'],
  ['_', '_'],
  ['.', '.'],
  ['!', '!'],
  ['~', '%7e'],
  ['*', '*'],
  ['(', '('],
  [')', ')'],
  [' ', '+'],
  ['@', '%40'],
  ['#', '%23'],
  ['$', '%24'],
  ['%', '%25'],
  ['^', '%5e'],
  ['&', '%26'],
  ['=', '%3d'],
  ['+', '%2b'],
  [';', '%3b'],
  ['?', '%3f'],
  ['/', '%2f'],
  ['\\', '%5c'],
  ['>', '%3e'],
  ['<', '%3c'],
  ['`', '%60'],
  ['[', '%5b'],
  [']', '%5d'],
  ['{', '%7b'],
  ['}', '%7d'],
  [':', '%3a'],
  ["'", '%27'],
  ['"', '%22'],
  [',', '%2c'],
  ['|', '%7c'],
]);

export const SYNTHETIC_INVOICE_ROUNDTRIP = Object.freeze({
  payload: Object.freeze({
    RelateNumber: 'F0000000000000000000',
    CustomerName: '合成 買家',
    Items: Object.freeze([
      Object.freeze({
        ItemName: "A+B ~'測試'(1)*!",
        ItemPrice: 100,
      }),
    ]),
  }),
  expectedUrlEncoded:
    '%7B%22RelateNumber%22%3A%22F0000000000000000000%22%2C%22CustomerName%22%3A%22%E5%90%88%E6%88%90+%E8%B2%B7%E5%AE%B6%22%2C%22Items%22%3A%5B%7B%22ItemName%22%3A%22A%2BB+%7E%27%E6%B8%AC%E8%A9%A6%27(1)*!%22%2C%22ItemPrice%22%3A100%7D%5D%7D',
});
