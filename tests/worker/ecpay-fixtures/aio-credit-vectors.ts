/**
 * Golden test vectors for ECPay AIO credit-card profile `ecpay.aio.credit.v1`.
 *
 * All golden CheckMacValue digests in this file were recomputed independently
 * from the official algorithm (https://developers.ecpay.com.tw/2902/ and
 * https://developers.ecpay.com.tw/2904/) outside the repository using the
 * published public stage credentials for merchant 3002607 (page 2856).
 */

import type {
  CreditCheckoutFormInput,
  CreditCheckoutLineItem,
  CreditDetailQueryInput,
  DoActionRequestInput,
  TradeInfoQueryInput,
} from '../../../modules/agent-commerce/providers/ecpay/aio-credit/index.js';
import type { FormFields } from '../../../modules/agent-commerce/providers/ecpay/index.js';
import { STAGE_KEYS } from './vectors.js';

export const AIO_CREDIT_GOLDEN_MERCHANT_ID = STAGE_KEYS.aio3002607.merchantId;
export const AIO_CREDIT_GOLDEN_TRADE_NO = 'FVTPVXVR14D2PF2DBSQQ';

export const CHECKOUT_FORBIDDEN_FIELDS: readonly string[] = Object.freeze([
  'PlatformID',
  'StoreID',
  'CustomField1',
  'CustomField2',
  'CustomField3',
  'CustomField4',
  'Language',
  'ChooseSubPayment',
  'UnionPay',
  'Redeem',
  'BindingCard',
  'MerchantMemberID',
  'CreditInstallment',
  'IgnorePayment',
  'Remark',
  'ItemURL',
]);

export const CHECKOUT_COMMON_LINES: readonly CreditCheckoutLineItem[] = Object.freeze([
  Object.freeze({ name: '合成測試 T恤 #1 <限定>', quantity: 2 }),
  Object.freeze({ name: '貼紙|組;`echo`', quantity: 1 }),
]);

export const CHECKOUT_FALLBACK_LINES: readonly CreditCheckoutLineItem[] = Object.freeze(
  Array.from({ length: 30 }, () =>
    Object.freeze({ name: '合成測試商品名稱很長很長', quantity: 1 }),
  ),
);

export const CHECKOUT_COMMON_BASE = Object.freeze({
  environment: 'sandbox' as const,
  merchantId: AIO_CREDIT_GOLDEN_MERCHANT_ID,
  merchantTradeNo: AIO_CREDIT_GOLDEN_TRADE_NO,
  currency: 'TWD',
  totalMinor: 150000,
  displayNumber: '261015-7K3QPZ',
  storeName: '合成小舖',
  lines: CHECKOUT_COMMON_LINES,
  returnUrl: 'https://freedom.example.com/api/v1/provider-callbacks/ecpay/acct01/payment',
  orderResultUrl: 'https://freedom.example.com/pay/ecpay/return/acct01',
  clientBackUrl: 'https://freedom.example.com/shops/demo-shop/orders/ord01',
});

export interface CheckoutGoldenVector {
  readonly id:
    | 'checkout-golden'
    | 'checkout-midnight'
    | 'checkout-newyear'
    | 'checkout-fallback';
  readonly input: CreditCheckoutFormInput;
  readonly expectedAction: string;
  readonly expectedMerchantTradeDate: string;
  readonly expectedItemName: string;
  readonly expectedTradeDesc: string;
  readonly expectedTotalAmount: string;
  readonly expectedCheckMacValue: string;
  readonly expectedFields: FormFields;
}

function buildExpectedCheckoutFields(
  merchantTradeDate: string,
  itemName: string,
  checkMacValue: string,
): FormFields {
  return Object.freeze<FormFields>([
    ['MerchantID', CHECKOUT_COMMON_BASE.merchantId],
    ['MerchantTradeNo', CHECKOUT_COMMON_BASE.merchantTradeNo],
    ['MerchantTradeDate', merchantTradeDate],
    ['PaymentType', 'aio'],
    ['TotalAmount', '1500'],
    ['TradeDesc', 'Freedom order 261015-7K3QPZ'],
    ['ItemName', itemName],
    ['ReturnURL', CHECKOUT_COMMON_BASE.returnUrl],
    ['ChoosePayment', 'Credit'],
    ['EncryptType', '1'],
    ['ClientBackURL', CHECKOUT_COMMON_BASE.clientBackUrl],
    ['OrderResultURL', CHECKOUT_COMMON_BASE.orderResultUrl],
    ['NeedExtraPaidInfo', 'Y'],
    ['CheckMacValue', checkMacValue],
  ]);
}

export const CHECKOUT_GOLDEN_VECTORS: readonly CheckoutGoldenVector[] = Object.freeze([
  Object.freeze({
    id: 'checkout-golden',
    input: Object.freeze({
      ...CHECKOUT_COMMON_BASE,
      createdAtEpochMs: 1792026123000,
    }),
    expectedAction: 'https://payment-stage.ecpay.com.tw/Cashier/AioCheckOut/V5',
    expectedMerchantTradeDate: '2026/10/15 09:02:03',
    expectedItemName: '合成測試 T恤 1 限定 x2#貼紙 組 echo x1',
    expectedTradeDesc: 'Freedom order 261015-7K3QPZ',
    expectedTotalAmount: '1500',
    expectedCheckMacValue:
      '3C7BA19682433F0EEF3D6455DA2A409F2861C2C4FBE03633C4E14919501AFEA9',
    expectedFields: buildExpectedCheckoutFields(
      '2026/10/15 09:02:03',
      '合成測試 T恤 1 限定 x2#貼紙 組 echo x1',
      '3C7BA19682433F0EEF3D6455DA2A409F2861C2C4FBE03633C4E14919501AFEA9',
    ),
  }),
  Object.freeze({
    id: 'checkout-midnight',
    input: Object.freeze({
      ...CHECKOUT_COMMON_BASE,
      createdAtEpochMs: 1791995400000,
    }),
    expectedAction: 'https://payment-stage.ecpay.com.tw/Cashier/AioCheckOut/V5',
    expectedMerchantTradeDate: '2026/10/15 00:30:00',
    expectedItemName: '合成測試 T恤 1 限定 x2#貼紙 組 echo x1',
    expectedTradeDesc: 'Freedom order 261015-7K3QPZ',
    expectedTotalAmount: '1500',
    expectedCheckMacValue:
      '222C80850909CBA041B31EF2953685AFE70EB5A194227B2473927769C8B6C53F',
    expectedFields: buildExpectedCheckoutFields(
      '2026/10/15 00:30:00',
      '合成測試 T恤 1 限定 x2#貼紙 組 echo x1',
      '222C80850909CBA041B31EF2953685AFE70EB5A194227B2473927769C8B6C53F',
    ),
  }),
  Object.freeze({
    id: 'checkout-newyear',
    input: Object.freeze({
      ...CHECKOUT_COMMON_BASE,
      createdAtEpochMs: 1798732800000,
    }),
    expectedAction: 'https://payment-stage.ecpay.com.tw/Cashier/AioCheckOut/V5',
    expectedMerchantTradeDate: '2027/01/01 00:00:00',
    expectedItemName: '合成測試 T恤 1 限定 x2#貼紙 組 echo x1',
    expectedTradeDesc: 'Freedom order 261015-7K3QPZ',
    expectedTotalAmount: '1500',
    expectedCheckMacValue:
      '5CBC7F2C997D19A5CBCF14E6AF76840CF6BF241FE4AB2A072C7ED8D2C1FB6B14',
    expectedFields: buildExpectedCheckoutFields(
      '2027/01/01 00:00:00',
      '合成測試 T恤 1 限定 x2#貼紙 組 echo x1',
      '5CBC7F2C997D19A5CBCF14E6AF76840CF6BF241FE4AB2A072C7ED8D2C1FB6B14',
    ),
  }),
  Object.freeze({
    id: 'checkout-fallback',
    input: Object.freeze({
      ...CHECKOUT_COMMON_BASE,
      createdAtEpochMs: 1792026123000,
      lines: CHECKOUT_FALLBACK_LINES,
    }),
    expectedAction: 'https://payment-stage.ecpay.com.tw/Cashier/AioCheckOut/V5',
    expectedMerchantTradeDate: '2026/10/15 09:02:03',
    expectedItemName: '合成小舖商品一批 x1',
    expectedTradeDesc: 'Freedom order 261015-7K3QPZ',
    expectedTotalAmount: '1500',
    expectedCheckMacValue:
      '948C42F8ADC6AC87097378920EED89DF75D7426DC15ED6F1BFB281428283D1B0',
    expectedFields: buildExpectedCheckoutFields(
      '2026/10/15 09:02:03',
      '合成小舖商品一批 x1',
      '948C42F8ADC6AC87097378920EED89DF75D7426DC15ED6F1BFB281428283D1B0',
    ),
  }),
]);

export const QUERY_GOLDEN_VECTOR = Object.freeze({
  id: 'query' as const,
  input: Object.freeze<TradeInfoQueryInput>({
    environment: 'sandbox',
    merchantId: AIO_CREDIT_GOLDEN_MERCHANT_ID,
    merchantTradeNo: AIO_CREDIT_GOLDEN_TRADE_NO,
    timestampSeconds: 1792026123,
  }),
  expectedUrl: 'https://payment-stage.ecpay.com.tw/Cashier/QueryTradeInfo/V5',
  expectedCheckMacValue:
    'F35BDEDB21E47CF57364140D62129BAFB036CCA8CEC9A9D7507D2C0ED64799AB',
  expectedFields: Object.freeze<FormFields>([
    ['MerchantID', AIO_CREDIT_GOLDEN_MERCHANT_ID],
    ['MerchantTradeNo', AIO_CREDIT_GOLDEN_TRADE_NO],
    ['TimeStamp', '1792026123'],
    [
      'CheckMacValue',
      'F35BDEDB21E47CF57364140D62129BAFB036CCA8CEC9A9D7507D2C0ED64799AB',
    ],
  ]),
});

export const DO_ACTION_GOLDEN_VECTOR = Object.freeze({
  id: 'do-action-r-500' as const,
  input: Object.freeze<DoActionRequestInput>({
    environment: 'live',
    merchantId: AIO_CREDIT_GOLDEN_MERCHANT_ID,
    merchantTradeNo: AIO_CREDIT_GOLDEN_TRADE_NO,
    tradeNo: '2610150902037371',
    action: 'R',
    amountMinor: 50000,
  }),
  expectedUrl: 'https://payment.ecpay.com.tw/CreditDetail/DoAction',
  expectedCheckMacValue:
    'BDDB0D11AB6672F2A005B2DA3AE9C246061E13042E243B868A4B2C5A269FB1F0',
  expectedFields: Object.freeze<FormFields>([
    ['MerchantID', AIO_CREDIT_GOLDEN_MERCHANT_ID],
    ['MerchantTradeNo', AIO_CREDIT_GOLDEN_TRADE_NO],
    ['TradeNo', '2610150902037371'],
    ['Action', 'R'],
    ['TotalAmount', '500'],
    [
      'CheckMacValue',
      'BDDB0D11AB6672F2A005B2DA3AE9C246061E13042E243B868A4B2C5A269FB1F0',
    ],
  ]),
});

export const CREDIT_DETAIL_GOLDEN_VECTOR = Object.freeze({
  id: 'credit-detail' as const,
  input: Object.freeze<CreditDetailQueryInput>({
    environment: 'live',
    merchantId: AIO_CREDIT_GOLDEN_MERCHANT_ID,
    gwsr: '11943021',
    amountMinor: 150000,
  }),
  creditCheckCode: STAGE_KEYS.aio3002607.creditCheckCode,
  expectedUrl: 'https://payment.ecpay.com.tw/CreditDetail/QueryTrade/V2',
  expectedCheckMacValue:
    '89730CEB7D5544AE81F09EE312FBF41CB6D049161D038177BF4A796A91213F49',
  expectedFields: Object.freeze<FormFields>([
    ['MerchantID', AIO_CREDIT_GOLDEN_MERCHANT_ID],
    ['CreditRefundId', '11943021'],
    ['CreditAmount', '1500'],
    ['CreditCheckCode', STAGE_KEYS.aio3002607.creditCheckCode],
    [
      'CheckMacValue',
      '89730CEB7D5544AE81F09EE312FBF41CB6D049161D038177BF4A796A91213F49',
    ],
  ]),
});
