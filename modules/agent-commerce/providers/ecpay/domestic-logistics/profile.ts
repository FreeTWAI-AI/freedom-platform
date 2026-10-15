import { EcpayProtocolError } from '../errors.js';

export const ECPAY_DOMESTIC_LOGISTICS_PROFILE =
  'ecpay.logistics.domestic.v1' as const;

export type EcpayLogisticsType = 'CVS' | 'HOME';
export type EcpayCvsSubType = 'UNIMARTC2C' | 'FAMIC2C' | 'HILIFEC2C';
export type EcpayHomeSubType = 'TCAT' | 'POST';
export type EcpayLogisticsSubType = EcpayCvsSubType | EcpayHomeSubType;

export interface EcpayLogisticsSubTypeDescriptor {
  readonly subType: EcpayLogisticsSubType;
  readonly logisticsType: EcpayLogisticsType;
  readonly serviceKey: string;
  readonly printPath: string;
  readonly supportsPrintMode: boolean;
  readonly supportsCancel: boolean;
  readonly supportsStoreUpdate: boolean;
  readonly orderValidDays: number | null;
  readonly maxGoodsAmountTwd: number | null;
  readonly maxWeightGrams: number | null;
}

export const ECPAY_LOGISTICS_SUBTYPES: Readonly<
  Record<EcpayLogisticsSubType, EcpayLogisticsSubTypeDescriptor>
> = Object.freeze({
  UNIMARTC2C: Object.freeze({
    subType: 'UNIMARTC2C' as const,
    logisticsType: 'CVS' as const,
    serviceKey: 'ecpay.logistics.cvs.unimartc2c',
    printPath: '/Express/PrintUniMartC2COrderInfo',
    supportsPrintMode: true,
    supportsCancel: true,
    supportsStoreUpdate: true,
    orderValidDays: 5,
    maxGoodsAmountTwd: 20000,
    maxWeightGrams: null,
  }),
  FAMIC2C: Object.freeze({
    subType: 'FAMIC2C' as const,
    logisticsType: 'CVS' as const,
    serviceKey: 'ecpay.logistics.cvs.famic2c',
    printPath: '/Express/PrintFAMIC2COrderInfo',
    supportsPrintMode: false,
    supportsCancel: false,
    supportsStoreUpdate: true,
    orderValidDays: 6,
    maxGoodsAmountTwd: 20000,
    maxWeightGrams: null,
  }),
  HILIFEC2C: Object.freeze({
    subType: 'HILIFEC2C' as const,
    logisticsType: 'CVS' as const,
    serviceKey: 'ecpay.logistics.cvs.hilifec2c',
    printPath: '/Express/PrintHILIFEC2COrderInfo',
    supportsPrintMode: false,
    supportsCancel: false,
    supportsStoreUpdate: true,
    orderValidDays: 7,
    maxGoodsAmountTwd: 20000,
    maxWeightGrams: null,
  }),
  TCAT: Object.freeze({
    subType: 'TCAT' as const,
    logisticsType: 'HOME' as const,
    serviceKey: 'ecpay.logistics.home.tcat',
    printPath: '/helper/printTradeDocument',
    supportsPrintMode: false,
    supportsCancel: false,
    supportsStoreUpdate: false,
    orderValidDays: null,
    maxGoodsAmountTwd: null,
    maxWeightGrams: null,
  }),
  POST: Object.freeze({
    subType: 'POST' as const,
    logisticsType: 'HOME' as const,
    serviceKey: 'ecpay.logistics.home.post',
    printPath: '/helper/printTradeDocument',
    supportsPrintMode: true,
    supportsCancel: false,
    supportsStoreUpdate: false,
    orderValidDays: null,
    maxGoodsAmountTwd: null,
    maxWeightGrams: 20000,
  }),
});

const SERVICE_KEY_TO_SUBTYPE: Readonly<Record<string, EcpayLogisticsSubType>> =
  Object.freeze({
    'ecpay.logistics.cvs.unimartc2c': 'UNIMARTC2C',
    'ecpay.logistics.cvs.famic2c': 'FAMIC2C',
    'ecpay.logistics.cvs.hilifec2c': 'HILIFEC2C',
    'ecpay.logistics.home.tcat': 'TCAT',
    'ecpay.logistics.home.post': 'POST',
  });

export function subTypeForServiceKey(
  serviceKey: string,
): EcpayLogisticsSubType | null {
  if (typeof serviceKey !== 'string') {
    return null;
  }
  if (!Object.prototype.hasOwnProperty.call(SERVICE_KEY_TO_SUBTYPE, serviceKey)) {
    return null;
  }
  return SERVICE_KEY_TO_SUBTYPE[serviceKey];
}

export function isLogisticsSubType(
  value: unknown,
): value is EcpayLogisticsSubType {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(ECPAY_LOGISTICS_SUBTYPES, value)
  );
}

export function assertLogisticsSubType(
  value: unknown,
): asserts value is EcpayLogisticsSubType {
  if (!isLogisticsSubType(value)) {
    throw new EcpayProtocolError('invalid_input');
  }
}

export function assertCvsSubType(
  value: unknown,
): asserts value is EcpayCvsSubType {
  if (!isLogisticsSubType(value) || ECPAY_LOGISTICS_SUBTYPES[value].logisticsType !== 'CVS') {
    throw new EcpayProtocolError('invalid_input');
  }
}

export function assertHomeSubType(
  value: unknown,
): asserts value is EcpayHomeSubType {
  if (!isLogisticsSubType(value) || ECPAY_LOGISTICS_SUBTYPES[value].logisticsType !== 'HOME') {
    throw new EcpayProtocolError('invalid_input');
  }
}
