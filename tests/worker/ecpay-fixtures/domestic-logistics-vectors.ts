/**
 * Golden test vectors for the ECPay domestic logistics profile (`ecpay.logistics.domestic.v1`).
 *
 * Every CheckMacValue below was recomputed independently from the official ECPay MD5
 * CheckMacValue algorithm (developer doc pages 7424, 7418) outside the repository using
 * ECPay's published public stage test keys (`STAGE_KEYS.logisticsC2c2000933` for C2C
 * merchant `2000933` and `STAGE_KEYS.shared2000132` for HOME merchant `2000132`).
 * All names, phones, addresses, URLs, and identifiers are synthetic test values.
 */

import type {
  CancelC2COrderInput,
  CreateOrderResponseResult,
  CvsCreateOrderInput,
  HomeCreateOrderInput,
  LogisticsNotification,
  LogisticsQueryFoundResult,
  LogisticsQueryRequestInput,
  ParseCreateOrderResponseOptions,
  ParseLogisticsNotificationOptions,
  ParseLogisticsQueryResponseOptions,
  PrintLabelFormInput,
  UpdateStoreInput,
} from '../../../modules/agent-commerce/providers/ecpay/domestic-logistics/index.js';
import type { FormFields } from '../../../modules/agent-commerce/providers/ecpay/index.js';
import { STAGE_KEYS, type StageKeySpec } from './vectors.js';

export const DOMESTIC_LOGISTICS_SANDBOX_ORIGIN =
  'https://logistics-stage.ecpay.com.tw';
export const DOMESTIC_LOGISTICS_CREATED_AT_EPOCH_MS = 1792026123000;
export const DOMESTIC_LOGISTICS_CREATED_AT_FORMATTED = '2026/10/15 09:02:03';
export const DOMESTIC_LOGISTICS_TIMESTAMP_SECONDS = 1792026123;
export const DOMESTIC_LOGISTICS_GOODS_AMOUNT_MINOR = 150000;
export const DOMESTIC_LOGISTICS_GOODS_AMOUNT_TWD = '1500';
export const DOMESTIC_LOGISTICS_SERVER_REPLY_URL =
  'https://freedom.example.com/api/v1/provider-callbacks/ecpay/acct02/logistics';

export const DOMESTIC_LOGISTICS_CVS_SENDER = Object.freeze({
  name: '合成寄件',
  cellPhone: '0912345678',
});

export const DOMESTIC_LOGISTICS_HOME_SENDER = Object.freeze({
  name: '合成寄件',
  cellPhone: '0912345678',
  zipCode: '10048',
  address: '臺北市中正區合成路1號',
});

export const DOMESTIC_LOGISTICS_CVS_RECEIVER_BASE = Object.freeze({
  name: '合成買家',
  cellPhone: '0987654321',
});

export const DOMESTIC_LOGISTICS_HOME_RECEIVER = Object.freeze({
  name: '合成買家',
  cellPhone: '0987654321',
  zipCode: '80146',
  address: '高雄市前金區合成街2號',
});

export interface CvsCreateOrderGoldenVector {
  readonly id: 'create-unimartc2c' | 'create-famic2c' | 'create-hilifec2c';
  readonly keys: StageKeySpec;
  readonly input: CvsCreateOrderInput;
  readonly expectedUrl: string;
  readonly expectedCheckMacValue: string;
  readonly expectedFields: FormFields;
}

export interface HomeCreateOrderGoldenVector {
  readonly id: 'create-tcat' | 'create-post';
  readonly keys: StageKeySpec;
  readonly input: HomeCreateOrderInput;
  readonly expectedUrl: string;
  readonly expectedCheckMacValue: string;
  readonly expectedFields: FormFields;
}

export interface LogisticsQueryRequestGoldenVector {
  readonly id: 'query-by-merchant-trade-no' | 'query-by-logistics-id';
  readonly keys: StageKeySpec;
  readonly input: LogisticsQueryRequestInput;
  readonly expectedUrl: string;
  readonly expectedCheckMacValue: string;
  readonly expectedFields: FormFields;
}

export interface PrintLabelGoldenVector {
  readonly id:
    | 'print-unimartc2c-a6'
    | 'print-famic2c'
    | 'print-hilifec2c'
    | 'print-tcat'
    | 'print-post-a6';
  readonly keys: StageKeySpec;
  readonly input: PrintLabelFormInput;
  readonly expectedAction: string;
  readonly expectedCheckMacValue: string;
  readonly expectedFields: FormFields;
}

export interface CancelC2CGoldenVector {
  readonly id: 'cancel-unimartc2c';
  readonly keys: StageKeySpec;
  readonly input: CancelC2COrderInput;
  readonly expectedUrl: string;
  readonly expectedCheckMacValue: string;
  readonly expectedFields: FormFields;
}

export interface UpdateStoreGoldenVector {
  readonly id: 'update-store-unimartc2c' | 'update-store-famic2c';
  readonly keys: StageKeySpec;
  readonly input: UpdateStoreInput;
  readonly expectedUrl: string;
  readonly expectedCheckMacValue: string;
  readonly expectedFields: FormFields;
}

export const CVS_CREATE_ORDER_GOLDEN_VECTORS: readonly CvsCreateOrderGoldenVector[] =
  Object.freeze([
    Object.freeze({
      id: 'create-unimartc2c' as const,
      keys: STAGE_KEYS.logisticsC2c2000933,
      input: Object.freeze<CvsCreateOrderInput>({
        environment: 'sandbox',
        merchantId: STAGE_KEYS.logisticsC2c2000933.merchantId,
        merchantTradeNo: 'L7K3QPZ2610150902AB1',
        createdAtEpochMs: DOMESTIC_LOGISTICS_CREATED_AT_EPOCH_MS,
        subType: 'UNIMARTC2C',
        goodsAmountMinor: DOMESTIC_LOGISTICS_GOODS_AMOUNT_MINOR,
        sender: DOMESTIC_LOGISTICS_CVS_SENDER,
        receiver: Object.freeze({
          ...DOMESTIC_LOGISTICS_CVS_RECEIVER_BASE,
          storeId: '131386',
        }),
        serverReplyUrl: DOMESTIC_LOGISTICS_SERVER_REPLY_URL,
      }),
      expectedUrl: `${DOMESTIC_LOGISTICS_SANDBOX_ORIGIN}/Express/Create`,
      expectedCheckMacValue: 'A8BABC8BD36BC204EEEDDEFB12DADF21',
      expectedFields: Object.freeze<FormFields>([
        ['MerchantID', '2000933'],
        ['MerchantTradeNo', 'L7K3QPZ2610150902AB1'],
        ['MerchantTradeDate', DOMESTIC_LOGISTICS_CREATED_AT_FORMATTED],
        ['LogisticsType', 'CVS'],
        ['LogisticsSubType', 'UNIMARTC2C'],
        ['GoodsAmount', DOMESTIC_LOGISTICS_GOODS_AMOUNT_TWD],
        ['IsCollection', 'N'],
        ['GoodsName', '訂購商品'],
        ['SenderName', '合成寄件'],
        ['SenderCellPhone', '0912345678'],
        ['ReceiverName', '合成買家'],
        ['ReceiverCellPhone', '0987654321'],
        ['ServerReplyURL', DOMESTIC_LOGISTICS_SERVER_REPLY_URL],
        ['ReceiverStoreID', '131386'],
        ['CheckMacValue', 'A8BABC8BD36BC204EEEDDEFB12DADF21'],
      ]),
    }),
    Object.freeze({
      id: 'create-famic2c' as const,
      keys: STAGE_KEYS.logisticsC2c2000933,
      input: Object.freeze<CvsCreateOrderInput>({
        environment: 'sandbox',
        merchantId: STAGE_KEYS.logisticsC2c2000933.merchantId,
        merchantTradeNo: 'L7K3QPZ2610150902AB2',
        createdAtEpochMs: DOMESTIC_LOGISTICS_CREATED_AT_EPOCH_MS,
        subType: 'FAMIC2C',
        goodsAmountMinor: DOMESTIC_LOGISTICS_GOODS_AMOUNT_MINOR,
        sender: DOMESTIC_LOGISTICS_CVS_SENDER,
        receiver: Object.freeze({
          ...DOMESTIC_LOGISTICS_CVS_RECEIVER_BASE,
          storeId: '006598',
        }),
        serverReplyUrl: DOMESTIC_LOGISTICS_SERVER_REPLY_URL,
      }),
      expectedUrl: `${DOMESTIC_LOGISTICS_SANDBOX_ORIGIN}/Express/Create`,
      expectedCheckMacValue: '3120ACE79FB416B220B1DAFCACF67292',
      expectedFields: Object.freeze<FormFields>([
        ['MerchantID', '2000933'],
        ['MerchantTradeNo', 'L7K3QPZ2610150902AB2'],
        ['MerchantTradeDate', DOMESTIC_LOGISTICS_CREATED_AT_FORMATTED],
        ['LogisticsType', 'CVS'],
        ['LogisticsSubType', 'FAMIC2C'],
        ['GoodsAmount', DOMESTIC_LOGISTICS_GOODS_AMOUNT_TWD],
        ['IsCollection', 'N'],
        ['GoodsName', '訂購商品'],
        ['SenderName', '合成寄件'],
        ['SenderCellPhone', '0912345678'],
        ['ReceiverName', '合成買家'],
        ['ReceiverCellPhone', '0987654321'],
        ['ServerReplyURL', DOMESTIC_LOGISTICS_SERVER_REPLY_URL],
        ['ReceiverStoreID', '006598'],
        ['CheckMacValue', '3120ACE79FB416B220B1DAFCACF67292'],
      ]),
    }),
    Object.freeze({
      id: 'create-hilifec2c' as const,
      keys: STAGE_KEYS.logisticsC2c2000933,
      input: Object.freeze<CvsCreateOrderInput>({
        environment: 'sandbox',
        merchantId: STAGE_KEYS.logisticsC2c2000933.merchantId,
        merchantTradeNo: 'L7K3QPZ2610150902AB3',
        createdAtEpochMs: DOMESTIC_LOGISTICS_CREATED_AT_EPOCH_MS,
        subType: 'HILIFEC2C',
        goodsAmountMinor: DOMESTIC_LOGISTICS_GOODS_AMOUNT_MINOR,
        sender: DOMESTIC_LOGISTICS_CVS_SENDER,
        receiver: Object.freeze({
          ...DOMESTIC_LOGISTICS_CVS_RECEIVER_BASE,
          storeId: '2001',
        }),
        serverReplyUrl: DOMESTIC_LOGISTICS_SERVER_REPLY_URL,
      }),
      expectedUrl: `${DOMESTIC_LOGISTICS_SANDBOX_ORIGIN}/Express/Create`,
      expectedCheckMacValue: '46A23F1FAD01DAE64CB7E072E2B8ACC8',
      expectedFields: Object.freeze<FormFields>([
        ['MerchantID', '2000933'],
        ['MerchantTradeNo', 'L7K3QPZ2610150902AB3'],
        ['MerchantTradeDate', DOMESTIC_LOGISTICS_CREATED_AT_FORMATTED],
        ['LogisticsType', 'CVS'],
        ['LogisticsSubType', 'HILIFEC2C'],
        ['GoodsAmount', DOMESTIC_LOGISTICS_GOODS_AMOUNT_TWD],
        ['IsCollection', 'N'],
        ['GoodsName', '訂購商品'],
        ['SenderName', '合成寄件'],
        ['SenderCellPhone', '0912345678'],
        ['ReceiverName', '合成買家'],
        ['ReceiverCellPhone', '0987654321'],
        ['ServerReplyURL', DOMESTIC_LOGISTICS_SERVER_REPLY_URL],
        ['ReceiverStoreID', '2001'],
        ['CheckMacValue', '46A23F1FAD01DAE64CB7E072E2B8ACC8'],
      ]),
    }),
  ]);

export const HOME_CREATE_ORDER_GOLDEN_VECTORS: readonly HomeCreateOrderGoldenVector[] =
  Object.freeze([
    Object.freeze({
      id: 'create-tcat' as const,
      keys: STAGE_KEYS.shared2000132,
      input: Object.freeze<HomeCreateOrderInput>({
        environment: 'sandbox',
        merchantId: STAGE_KEYS.shared2000132.merchantId,
        merchantTradeNo: 'L8M4RS6T0VW2XY4Z6A8B',
        createdAtEpochMs: DOMESTIC_LOGISTICS_CREATED_AT_EPOCH_MS,
        subType: 'TCAT',
        goodsAmountMinor: DOMESTIC_LOGISTICS_GOODS_AMOUNT_MINOR,
        sender: DOMESTIC_LOGISTICS_HOME_SENDER,
        receiver: DOMESTIC_LOGISTICS_HOME_RECEIVER,
        serverReplyUrl: DOMESTIC_LOGISTICS_SERVER_REPLY_URL,
        distance: 'other_county',
        sizeCm: 60,
      }),
      expectedUrl: `${DOMESTIC_LOGISTICS_SANDBOX_ORIGIN}/Express/Create`,
      expectedCheckMacValue: 'AD3CC8A67404C0505AD9ADF8E9635178',
      expectedFields: Object.freeze<FormFields>([
        ['MerchantID', '2000132'],
        ['MerchantTradeNo', 'L8M4RS6T0VW2XY4Z6A8B'],
        ['MerchantTradeDate', DOMESTIC_LOGISTICS_CREATED_AT_FORMATTED],
        ['LogisticsType', 'HOME'],
        ['LogisticsSubType', 'TCAT'],
        ['GoodsAmount', DOMESTIC_LOGISTICS_GOODS_AMOUNT_TWD],
        ['IsCollection', 'N'],
        ['GoodsName', '訂購商品'],
        ['SenderName', '合成寄件'],
        ['SenderCellPhone', '0912345678'],
        ['SenderZipCode', '10048'],
        ['SenderAddress', '臺北市中正區合成路1號'],
        ['ReceiverName', '合成買家'],
        ['ReceiverCellPhone', '0987654321'],
        ['ReceiverZipCode', '80146'],
        ['ReceiverAddress', '高雄市前金區合成街2號'],
        ['Temperature', '0001'],
        ['Distance', '01'],
        ['Specification', '0001'],
        ['ScheduledPickupTime', '4'],
        ['ScheduledDeliveryTime', '4'],
        ['ServerReplyURL', DOMESTIC_LOGISTICS_SERVER_REPLY_URL],
        ['CheckMacValue', 'AD3CC8A67404C0505AD9ADF8E9635178'],
      ]),
    }),
    Object.freeze({
      id: 'create-post' as const,
      keys: STAGE_KEYS.shared2000132,
      input: Object.freeze<HomeCreateOrderInput>({
        environment: 'sandbox',
        merchantId: STAGE_KEYS.shared2000132.merchantId,
        merchantTradeNo: 'L9N5ST7V1WX3YZ5A7B9C',
        createdAtEpochMs: DOMESTIC_LOGISTICS_CREATED_AT_EPOCH_MS,
        subType: 'POST',
        goodsAmountMinor: DOMESTIC_LOGISTICS_GOODS_AMOUNT_MINOR,
        sender: DOMESTIC_LOGISTICS_HOME_SENDER,
        receiver: DOMESTIC_LOGISTICS_HOME_RECEIVER,
        serverReplyUrl: DOMESTIC_LOGISTICS_SERVER_REPLY_URL,
        weightGrams: 1500,
      }),
      expectedUrl: `${DOMESTIC_LOGISTICS_SANDBOX_ORIGIN}/Express/Create`,
      expectedCheckMacValue: '3708408AF42E74647F424C19AECCAC59',
      expectedFields: Object.freeze<FormFields>([
        ['MerchantID', '2000132'],
        ['MerchantTradeNo', 'L9N5ST7V1WX3YZ5A7B9C'],
        ['MerchantTradeDate', DOMESTIC_LOGISTICS_CREATED_AT_FORMATTED],
        ['LogisticsType', 'HOME'],
        ['LogisticsSubType', 'POST'],
        ['GoodsAmount', DOMESTIC_LOGISTICS_GOODS_AMOUNT_TWD],
        ['GoodsName', '訂購商品'],
        ['GoodsWeight', '1.5'],
        ['SenderName', '合成寄件'],
        ['SenderCellPhone', '0912345678'],
        ['SenderZipCode', '10048'],
        ['SenderAddress', '臺北市中正區合成路1號'],
        ['ReceiverName', '合成買家'],
        ['ReceiverCellPhone', '0987654321'],
        ['ReceiverZipCode', '80146'],
        ['ReceiverAddress', '高雄市前金區合成街2號'],
        ['Temperature', '0001'],
        ['ServerReplyURL', DOMESTIC_LOGISTICS_SERVER_REPLY_URL],
        ['CheckMacValue', '3708408AF42E74647F424C19AECCAC59'],
      ]),
    }),
  ]);

export const QUERY_REQUEST_GOLDEN_VECTORS: readonly LogisticsQueryRequestGoldenVector[] =
  Object.freeze([
    Object.freeze({
      id: 'query-by-merchant-trade-no' as const,
      keys: STAGE_KEYS.shared2000132,
      input: Object.freeze<LogisticsQueryRequestInput>({
        environment: 'sandbox',
        merchantId: STAGE_KEYS.shared2000132.merchantId,
        merchantTradeNo: 'L8M4RS6T0VW2XY4Z6A8B',
        timestampSeconds: DOMESTIC_LOGISTICS_TIMESTAMP_SECONDS,
      }),
      expectedUrl: `${DOMESTIC_LOGISTICS_SANDBOX_ORIGIN}/Helper/QueryLogisticsTradeInfo/V5`,
      expectedCheckMacValue: '134D1A355C89FAAABC67051693B8721C',
      expectedFields: Object.freeze<FormFields>([
        ['MerchantID', '2000132'],
        ['MerchantTradeNo', 'L8M4RS6T0VW2XY4Z6A8B'],
        ['TimeStamp', '1792026123'],
        ['CheckMacValue', '134D1A355C89FAAABC67051693B8721C'],
      ]),
    }),
    Object.freeze({
      id: 'query-by-logistics-id' as const,
      keys: STAGE_KEYS.logisticsC2c2000933,
      input: Object.freeze<LogisticsQueryRequestInput>({
        environment: 'sandbox',
        merchantId: STAGE_KEYS.logisticsC2c2000933.merchantId,
        allPayLogisticsId: '2610150001',
        timestampSeconds: DOMESTIC_LOGISTICS_TIMESTAMP_SECONDS,
      }),
      expectedUrl: `${DOMESTIC_LOGISTICS_SANDBOX_ORIGIN}/Helper/QueryLogisticsTradeInfo/V5`,
      expectedCheckMacValue: 'C172F1FABFC4EAF31C3EE1B61251D5E9',
      expectedFields: Object.freeze<FormFields>([
        ['MerchantID', '2000933'],
        ['AllPayLogisticsID', '2610150001'],
        ['TimeStamp', '1792026123'],
        ['CheckMacValue', 'C172F1FABFC4EAF31C3EE1B61251D5E9'],
      ]),
    }),
  ]);

export const PRINT_LABEL_GOLDEN_VECTORS: readonly PrintLabelGoldenVector[] =
  Object.freeze([
    Object.freeze({
      id: 'print-unimartc2c-a6' as const,
      keys: STAGE_KEYS.logisticsC2c2000933,
      input: Object.freeze<PrintLabelFormInput>({
        environment: 'sandbox',
        merchantId: STAGE_KEYS.logisticsC2c2000933.merchantId,
        subType: 'UNIMARTC2C',
        allPayLogisticsId: '2610150001',
        cvsPaymentNo: '12345678',
        cvsValidationNo: '1234',
        printMode: 'a6',
      }),
      expectedAction: `${DOMESTIC_LOGISTICS_SANDBOX_ORIGIN}/Express/PrintUniMartC2COrderInfo`,
      expectedCheckMacValue: '9D5FC970B42C362251716D5562AAE0ED',
      expectedFields: Object.freeze<FormFields>([
        ['MerchantID', '2000933'],
        ['AllPayLogisticsID', '2610150001'],
        ['CVSPaymentNo', '12345678'],
        ['CVSValidationNo', '1234'],
        ['PrintMode', '2'],
        ['CheckMacValue', '9D5FC970B42C362251716D5562AAE0ED'],
      ]),
    }),
    Object.freeze({
      id: 'print-famic2c' as const,
      keys: STAGE_KEYS.logisticsC2c2000933,
      input: Object.freeze<PrintLabelFormInput>({
        environment: 'sandbox',
        merchantId: STAGE_KEYS.logisticsC2c2000933.merchantId,
        subType: 'FAMIC2C',
        allPayLogisticsId: '2610150002',
        cvsPaymentNo: '12345678901',
      }),
      expectedAction: `${DOMESTIC_LOGISTICS_SANDBOX_ORIGIN}/Express/PrintFAMIC2COrderInfo`,
      expectedCheckMacValue: '3868AB9223873F86BDE6A73F845F036C',
      expectedFields: Object.freeze<FormFields>([
        ['MerchantID', '2000933'],
        ['AllPayLogisticsID', '2610150002'],
        ['CVSPaymentNo', '12345678901'],
        ['CheckMacValue', '3868AB9223873F86BDE6A73F845F036C'],
      ]),
    }),
    Object.freeze({
      id: 'print-hilifec2c' as const,
      keys: STAGE_KEYS.logisticsC2c2000933,
      input: Object.freeze<PrintLabelFormInput>({
        environment: 'sandbox',
        merchantId: STAGE_KEYS.logisticsC2c2000933.merchantId,
        subType: 'HILIFEC2C',
        allPayLogisticsId: '2610150003',
        cvsPaymentNo: '1234567890',
      }),
      expectedAction: `${DOMESTIC_LOGISTICS_SANDBOX_ORIGIN}/Express/PrintHILIFEC2COrderInfo`,
      expectedCheckMacValue: 'C04D49473F1470ED9636D1DE01526DB0',
      expectedFields: Object.freeze<FormFields>([
        ['MerchantID', '2000933'],
        ['AllPayLogisticsID', '2610150003'],
        ['CVSPaymentNo', '1234567890'],
        ['CheckMacValue', 'C04D49473F1470ED9636D1DE01526DB0'],
      ]),
    }),
    Object.freeze({
      id: 'print-tcat' as const,
      keys: STAGE_KEYS.shared2000132,
      input: Object.freeze<PrintLabelFormInput>({
        environment: 'sandbox',
        merchantId: STAGE_KEYS.shared2000132.merchantId,
        subType: 'TCAT',
        allPayLogisticsId: '2610150004',
      }),
      expectedAction: `${DOMESTIC_LOGISTICS_SANDBOX_ORIGIN}/helper/printTradeDocument`,
      expectedCheckMacValue: '0E55A89C4E7F1DD1D52986114E47DF20',
      expectedFields: Object.freeze<FormFields>([
        ['MerchantID', '2000132'],
        ['AllPayLogisticsID', '2610150004'],
        ['CheckMacValue', '0E55A89C4E7F1DD1D52986114E47DF20'],
      ]),
    }),
    Object.freeze({
      id: 'print-post-a6' as const,
      keys: STAGE_KEYS.shared2000132,
      input: Object.freeze<PrintLabelFormInput>({
        environment: 'sandbox',
        merchantId: STAGE_KEYS.shared2000132.merchantId,
        subType: 'POST',
        allPayLogisticsId: '2610150005',
        printMode: 'a6',
      }),
      expectedAction: `${DOMESTIC_LOGISTICS_SANDBOX_ORIGIN}/helper/printTradeDocument`,
      expectedCheckMacValue: '13611B7D9F0B106565916E21AB78F2FB',
      expectedFields: Object.freeze<FormFields>([
        ['MerchantID', '2000132'],
        ['AllPayLogisticsID', '2610150005'],
        ['PrintMode', '2'],
        ['CheckMacValue', '13611B7D9F0B106565916E21AB78F2FB'],
      ]),
    }),
  ]);

export const CANCEL_C2C_GOLDEN_VECTOR: CancelC2CGoldenVector = Object.freeze({
  id: 'cancel-unimartc2c' as const,
  keys: STAGE_KEYS.logisticsC2c2000933,
  input: Object.freeze<CancelC2COrderInput>({
    environment: 'sandbox',
    merchantId: STAGE_KEYS.logisticsC2c2000933.merchantId,
    subType: 'UNIMARTC2C',
    allPayLogisticsId: '2610150001',
    cvsPaymentNo: '12345678',
    cvsValidationNo: '1234',
  }),
  expectedUrl: `${DOMESTIC_LOGISTICS_SANDBOX_ORIGIN}/Express/CancelC2COrder`,
  expectedCheckMacValue: 'BBAED182B1F77A89229528E42A4141F4',
  expectedFields: Object.freeze<FormFields>([
    ['MerchantID', '2000933'],
    ['AllPayLogisticsID', '2610150001'],
    ['CVSPaymentNo', '12345678'],
    ['CVSValidationNo', '1234'],
    ['CheckMacValue', 'BBAED182B1F77A89229528E42A4141F4'],
  ]),
});

export const UPDATE_STORE_GOLDEN_VECTORS: readonly UpdateStoreGoldenVector[] =
  Object.freeze([
    Object.freeze({
      id: 'update-store-unimartc2c' as const,
      keys: STAGE_KEYS.logisticsC2c2000933,
      input: Object.freeze<UpdateStoreInput>({
        environment: 'sandbox',
        merchantId: STAGE_KEYS.logisticsC2c2000933.merchantId,
        subType: 'UNIMARTC2C',
        allPayLogisticsId: '2610150001',
        cvsPaymentNo: '12345678',
        cvsValidationNo: '1234',
        receiverStoreId: '131386',
      }),
      expectedUrl: `${DOMESTIC_LOGISTICS_SANDBOX_ORIGIN}/Express/UpdateStoreInfo`,
      expectedCheckMacValue: '4E70733DF26D0D14E4034299AE62D2BC',
      expectedFields: Object.freeze<FormFields>([
        ['MerchantID', '2000933'],
        ['AllPayLogisticsID', '2610150001'],
        ['CVSPaymentNo', '12345678'],
        ['CVSValidationNo', '1234'],
        ['StoreType', '01'],
        ['ReceiverStoreID', '131386'],
        ['CheckMacValue', '4E70733DF26D0D14E4034299AE62D2BC'],
      ]),
    }),
    Object.freeze({
      id: 'update-store-famic2c' as const,
      keys: STAGE_KEYS.logisticsC2c2000933,
      input: Object.freeze<UpdateStoreInput>({
        environment: 'sandbox',
        merchantId: STAGE_KEYS.logisticsC2c2000933.merchantId,
        subType: 'FAMIC2C',
        allPayLogisticsId: '2610150002',
        cvsPaymentNo: '12345678901',
        receiverStoreId: '006598',
      }),
      expectedUrl: `${DOMESTIC_LOGISTICS_SANDBOX_ORIGIN}/Express/UpdateStoreInfo`,
      expectedCheckMacValue: '6489AEDAB19E37C12352E11647CF7A11',
      expectedFields: Object.freeze<FormFields>([
        ['MerchantID', '2000933'],
        ['AllPayLogisticsID', '2610150002'],
        ['CVSPaymentNo', '12345678901'],
        ['StoreType', '01'],
        ['ReceiverStoreID', '006598'],
        ['CheckMacValue', '6489AEDAB19E37C12352E11647CF7A11'],
      ]),
    }),
  ]);

export interface CreateResponseGoldenVector {
  readonly id: 'create-response-unimartc2c' | 'create-response-tcat';
  readonly keys: StageKeySpec;
  readonly unsignedFields: FormFields;
  readonly expectedCheckMacValue: string;
  readonly options: ParseCreateOrderResponseOptions;
  readonly expectedResult: CreateOrderResponseResult;
}

export const CREATE_RESPONSE_GOLDEN_VECTORS: readonly CreateResponseGoldenVector[] =
  Object.freeze([
    Object.freeze({
      id: 'create-response-unimartc2c' as const,
      keys: STAGE_KEYS.logisticsC2c2000933,
      unsignedFields: Object.freeze<FormFields>([
        ['MerchantID', '2000933'],
        ['MerchantTradeNo', 'L7K3QPZ2610150902AB1'],
        ['RtnCode', '300'],
        ['BookingNote', ''],
        ['RtnMsg', '訂單處理中(已收到訂單資料)'],
        ['AllPayLogisticsID', '2610150001'],
        ['LogisticsType', 'CVS'],
        ['LogisticsSubType', 'UNIMARTC2C'],
        ['GoodsAmount', '1500'],
        ['UpdateStatusDate', '2026/10/15 09:02:05'],
        ['ReceiverName', '合成買家'],
        ['ReceiverPhone', ''],
        ['ReceiverCellPhone', '0987654321'],
        ['ReceiverEmail', ''],
        ['ReceiverAddress', ''],
        ['CVSPaymentNo', '12345678'],
        ['CVSValidationNo', '1234'],
      ]),
      expectedCheckMacValue: '3386E02C07A8372556A1568B2AAE5515',
      options: Object.freeze<ParseCreateOrderResponseOptions>({
        merchantId: '2000933',
        merchantTradeNo: 'L7K3QPZ2610150902AB1',
        subType: 'UNIMARTC2C',
        goodsAmountMinor: 150000,
      }),
      expectedResult: Object.freeze<CreateOrderResponseResult>({
        kind: 'created',
        keyIndex: 0,
        merchantTradeNo: 'L7K3QPZ2610150902AB1',
        allPayLogisticsId: '2610150001',
        subType: 'UNIMARTC2C',
        rtnCode: '300',
        rtnMsg: '訂單處理中(已收到訂單資料)',
        updateStatusDate: '2026/10/15 09:02:05',
        updateStatusEpochMs: 1792026125000,
        cvsPaymentNo: '12345678',
        cvsValidationNo: '1234',
        bookingNote: null,
        ignoredFields: Object.freeze([]),
      }),
    }),
    Object.freeze({
      id: 'create-response-tcat' as const,
      keys: STAGE_KEYS.shared2000132,
      unsignedFields: Object.freeze<FormFields>([
        ['MerchantID', '2000132'],
        ['MerchantTradeNo', 'L8M4RS6T0VW2XY4Z6A8B'],
        ['RtnCode', '300'],
        ['BookingNote', '9010000001'],
        ['RtnMsg', '訂單處理中(已收到訂單資料)'],
        ['AllPayLogisticsID', '2610150004'],
        ['LogisticsType', 'HOME'],
        ['LogisticsSubType', 'TCAT'],
        ['GoodsAmount', '1500'],
        ['UpdateStatusDate', '2026/10/15 09:02:05'],
        ['ReceiverName', '合成買家'],
        ['ReceiverPhone', ''],
        ['ReceiverCellPhone', '0987654321'],
        ['ReceiverEmail', ''],
        ['ReceiverAddress', '高雄市前金區合成街2號'],
        ['CVSPaymentNo', ''],
        ['CVSValidationNo', ''],
      ]),
      expectedCheckMacValue: '6660FAA1770BCAF92CAE2AF20EC9147F',
      options: Object.freeze<ParseCreateOrderResponseOptions>({
        merchantId: '2000132',
        merchantTradeNo: 'L8M4RS6T0VW2XY4Z6A8B',
        subType: 'TCAT',
        goodsAmountMinor: 150000,
      }),
      expectedResult: Object.freeze<CreateOrderResponseResult>({
        kind: 'created',
        keyIndex: 0,
        merchantTradeNo: 'L8M4RS6T0VW2XY4Z6A8B',
        allPayLogisticsId: '2610150004',
        subType: 'TCAT',
        rtnCode: '300',
        rtnMsg: '訂單處理中(已收到訂單資料)',
        updateStatusDate: '2026/10/15 09:02:05',
        updateStatusEpochMs: 1792026125000,
        cvsPaymentNo: null,
        cvsValidationNo: null,
        bookingNote: '9010000001',
        ignoredFields: Object.freeze([]),
      }),
    }),
  ]);

export interface NotificationGoldenVector {
  readonly id: 'notification-unimartc2c-2067';
  readonly keys: StageKeySpec;
  readonly unsignedFields: FormFields;
  readonly expectedCheckMacValue: string;
  readonly options: ParseLogisticsNotificationOptions;
  readonly expectedWithoutBodySha256: Omit<LogisticsNotification, 'bodySha256'>;
}

export const NOTIFICATION_GOLDEN_VECTOR: NotificationGoldenVector =
  Object.freeze({
    id: 'notification-unimartc2c-2067' as const,
    keys: STAGE_KEYS.logisticsC2c2000933,
    unsignedFields: Object.freeze<FormFields>([
      ['MerchantID', '2000933'],
      ['MerchantTradeNo', 'L7K3QPZ2610150902AB1'],
      ['RtnCode', '2067'],
      ['RtnMsg', '消費者成功取件'],
      ['AllPayLogisticsID', '2610150001'],
      ['LogisticsType', 'CVS'],
      ['LogisticsSubType', 'UNIMARTC2C'],
      ['GoodsAmount', '1500'],
      ['UpdateStatusDate', '2026/10/18 14:05:09'],
      ['ReceiverName', '合成買家'],
      ['ReceiverPhone', ''],
      ['ReceiverCellPhone', '0987654321'],
      ['ReceiverEmail', 'buyer@example.com'],
      ['ReceiverAddress', ''],
      ['CVSPaymentNo', '12345678'],
      ['CVSValidationNo', '1234'],
      ['BookingNote', ''],
    ]),
    expectedCheckMacValue: 'DF2EDFEA5F9781CA4481463AB02BAE3D',
    options: Object.freeze<ParseLogisticsNotificationOptions>({
      merchantId: '2000933',
    }),
    expectedWithoutBodySha256: Object.freeze({
      kind: 'notification' as const,
      keyIndex: 0,
      merchantTradeNo: 'L7K3QPZ2610150902AB1',
      allPayLogisticsId: '2610150001',
      rtnCode: '2067',
      rtnMsg: '消費者成功取件',
      logisticsSubType: 'UNIMARTC2C',
      subType: 'UNIMARTC2C' as const,
      goodsAmountMinor: 150000,
      updateStatusDate: '2026/10/18 14:05:09',
      updateStatusEpochMs: 1792303509000,
      dedupe: Object.freeze({
        allPayLogisticsId: '2610150001',
        rtnCode: '2067',
        updateStatusDate: '2026/10/18 14:05:09',
      }),
    }),
  });

export interface QueryResponseGoldenVector {
  readonly id: 'query-response-tcat';
  readonly keys: StageKeySpec;
  readonly unsignedFields: FormFields;
  readonly expectedCheckMacValue: string;
  readonly options: ParseLogisticsQueryResponseOptions;
  readonly expectedResult: LogisticsQueryFoundResult;
}

export const QUERY_RESPONSE_GOLDEN_VECTOR: QueryResponseGoldenVector =
  Object.freeze({
    id: 'query-response-tcat' as const,
    keys: STAGE_KEYS.shared2000132,
    unsignedFields: Object.freeze<FormFields>([
      ['ActualWeight', 'null'],
      ['AllPayLogisticsID', '2610150004'],
      ['BookingNote', '9010000001'],
      ['CollectionAllocateAmount', '0'],
      ['CollectionAllocateDate', ''],
      ['CollectionAmount', '0'],
      ['CollectionChargeFee', '0'],
      ['CVSPaymentNo', ''],
      ['CVSValidationNo', ''],
      ['GoodsAmount', '1500'],
      ['GoodsName', '訂購商品'],
      ['GoodsWeight', 'null'],
      ['HandlingCharge', '130'],
      ['LogisticsStatus', '3001'],
      ['LogisticsType', 'HOME_TCAT'],
      ['MerchantID', '2000132'],
      ['MerchantTradeNo', 'L8M4RS6T0VW2XY4Z6A8B'],
      ['ShipChargeDate', '2026/10/16'],
      ['ShipmentNo', ''],
      ['TradeDate', '2026/10/15 09:02:05'],
      ['SenderName', '合成寄件'],
      ['SenderPhone', ''],
      ['SenderCellPhone', '0912345678'],
    ]),
    expectedCheckMacValue: '043C17E0C1C27A4EA2208AD575BC2E54',
    options: Object.freeze<ParseLogisticsQueryResponseOptions>({
      merchantId: '2000132',
      merchantTradeNo: 'L8M4RS6T0VW2XY4Z6A8B',
    }),
    expectedResult: Object.freeze<LogisticsQueryFoundResult>({
      kind: 'found',
      keyIndex: 0,
      merchantTradeNo: 'L8M4RS6T0VW2XY4Z6A8B',
      allPayLogisticsId: '2610150004',
      logisticsStatus: '3001',
      logisticsType: 'HOME_TCAT',
      subType: 'TCAT',
      goodsAmountMinor: 150000,
      handlingChargeMinor: 13000,
      shipChargeDate: '2026/10/16',
      tradeDate: '2026/10/15 09:02:05',
      tradeDateEpochMs: 1792026125000,
      cvsPaymentNo: null,
      cvsValidationNo: null,
      shipmentNo: null,
      bookingNote: '9010000001',
      ignoredFields: Object.freeze([]),
    }),
  });

export const POST_WEIGHT_FORMATTING_VECTORS: ReadonlyArray<
  readonly [number, string]
> = Object.freeze([
  [1500, '1.5'],
  [20000, '20'],
  [1000, '1'],
  [1, '0.001'],
  [10, '0.01'],
  [1050, '1.05'],
  [999, '0.999'],
]);
