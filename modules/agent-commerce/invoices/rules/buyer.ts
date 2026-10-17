import { InvoiceRuleError } from './errors.js';
import { isValidUbn } from './ubn.js';
import { isInvoiceEmail } from '../../providers/ecpay/b2c-invoice/index.js';

export type InvoiceBuyer =
  | { type: 'member_carrier' }
  | { type: 'mobile_barcode'; barcode: string }
  | { type: 'citizen_cert'; certificate: string }
  | { type: 'donation'; loveCode: string }
  | { type: 'company'; ubn: string; title: string; barcode?: string };

export type InvoiceBuyerErrorCode =
  | 'required'
  | 'format'
  | 'checksum'
  | 'not_allowed_for_type'
  | 'too_long'
  | 'unknown_type';

export interface InvoiceBuyerFieldError {
  field: string;
  code: InvoiceBuyerErrorCode;
}

export type NormalizeInvoiceBuyerResult =
  | { ok: true; buyer: InvoiceBuyer }
  | { ok: false; errors: InvoiceBuyerFieldError[] };

const ALLOWED_FIELDS_BY_TYPE: Record<InvoiceBuyer['type'], readonly string[]> = {
  member_carrier: ['type'],
  mobile_barcode: ['type', 'barcode'],
  citizen_cert: ['type', 'certificate'],
  donation: ['type', 'loveCode'],
  company: ['type', 'ubn', 'title', 'barcode'],
};

export function normalizeInvoiceBuyer(input: unknown): NormalizeInvoiceBuyerResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: [{ field: 'type', code: 'unknown_type' }] };
  }

  const record = input as Record<string, unknown>;
  const type = record.type;

  if (
    typeof type !== 'string' ||
    !Object.prototype.hasOwnProperty.call(ALLOWED_FIELDS_BY_TYPE, type)
  ) {
    return { ok: false, errors: [{ field: 'type', code: 'unknown_type' }] };
  }

  const buyerType = type as InvoiceBuyer['type'];
  const allowed = ALLOWED_FIELDS_BY_TYPE[buyerType];
  const errors: InvoiceBuyerFieldError[] = [];

  // Check for disallowed fields for this type
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      errors.push({ field: key, code: 'not_allowed_for_type' });
    }
  }

  let normalizedBuyer: InvoiceBuyer | null = null;

  switch (buyerType) {
    case 'member_carrier': {
      normalizedBuyer = { type: 'member_carrier' };
      break;
    }

    case 'mobile_barcode': {
      if (record.barcode === undefined || record.barcode === null || typeof record.barcode !== 'string') {
        errors.push({ field: 'barcode', code: 'required' });
      } else {
        const barcode = record.barcode.normalize('NFKC').trim().toUpperCase();
        if (barcode.length === 0) {
          errors.push({ field: 'barcode', code: 'required' });
        } else if (!/^\/[0-9A-Z+\-.]{7}$/.test(barcode)) {
          errors.push({ field: 'barcode', code: 'format' });
        } else {
          normalizedBuyer = { type: 'mobile_barcode', barcode };
        }
      }
      break;
    }

    case 'citizen_cert': {
      if (record.certificate === undefined || record.certificate === null || typeof record.certificate !== 'string') {
        errors.push({ field: 'certificate', code: 'required' });
      } else {
        const certificate = record.certificate.normalize('NFKC').trim().toUpperCase();
        if (certificate.length === 0) {
          errors.push({ field: 'certificate', code: 'required' });
        } else if (!/^[A-Z]{2}[0-9]{14}$/.test(certificate)) {
          errors.push({ field: 'certificate', code: 'format' });
        } else {
          normalizedBuyer = { type: 'citizen_cert', certificate };
        }
      }
      break;
    }

    case 'donation': {
      if (record.loveCode === undefined || record.loveCode === null || typeof record.loveCode !== 'string') {
        errors.push({ field: 'loveCode', code: 'required' });
      } else {
        const loveCode = record.loveCode.normalize('NFKC').trim();
        if (loveCode.length === 0) {
          errors.push({ field: 'loveCode', code: 'required' });
        } else if (!/^[0-9]{3,7}$/.test(loveCode)) {
          errors.push({ field: 'loveCode', code: 'format' });
        } else {
          normalizedBuyer = { type: 'donation', loveCode };
        }
      }
      break;
    }

    case 'company': {
      let ubnClean: string | undefined;
      let titleClean: string | undefined;
      let barcodeClean: string | undefined;

      // ubn check
      if (record.ubn === undefined || record.ubn === null || typeof record.ubn !== 'string') {
        errors.push({ field: 'ubn', code: 'required' });
      } else {
        const ubn = record.ubn.normalize('NFKC').trim();
        if (ubn.length === 0) {
          errors.push({ field: 'ubn', code: 'required' });
        } else if (!/^[0-9]{8}$/.test(ubn)) {
          errors.push({ field: 'ubn', code: 'format' });
        } else if (!isValidUbn(ubn)) {
          errors.push({ field: 'ubn', code: 'checksum' });
        } else {
          ubnClean = ubn;
        }
      }

      // title check
      if (record.title === undefined || record.title === null || typeof record.title !== 'string') {
        errors.push({ field: 'title', code: 'required' });
      } else {
        const title = record.title
          .normalize('NFKC')
          .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
          .replace(/\s+/g, ' ')
          .trim();
        const codePoints = Array.from(title).length;
        if (codePoints === 0) {
          errors.push({ field: 'title', code: 'required' });
        } else if (codePoints > 60) {
          errors.push({ field: 'title', code: 'too_long' });
        } else {
          titleClean = title;
        }
      }

      // barcode check (optional)
      if (record.barcode !== undefined && record.barcode !== null) {
        if (typeof record.barcode !== 'string') {
          errors.push({ field: 'barcode', code: 'format' });
        } else {
          const barcode = record.barcode.normalize('NFKC').trim().toUpperCase();
          if (barcode.length > 0) {
            if (!/^\/[0-9A-Z+\-.]{7}$/.test(barcode)) {
              errors.push({ field: 'barcode', code: 'format' });
            } else {
              barcodeClean = barcode;
            }
          }
        }
      }

      if (ubnClean !== undefined && titleClean !== undefined) {
        const comp: InvoiceBuyer = {
          type: 'company',
          ubn: ubnClean,
          title: titleClean,
        };
        if (barcodeClean !== undefined) {
          comp.barcode = barcodeClean;
        }
        normalizedBuyer = comp;
      }
      break;
    }
  }

  if (errors.length > 0 || !normalizedBuyer) {
    return { ok: false, errors };
  }

  return { ok: true, buyer: normalizedBuyer };
}

export interface EcpayBuyerFields {
  CustomerIdentifier: string;
  CustomerName: string;
  CarrierType: string;
  CarrierNum: string;
  Print: string;
  Donation: string;
  LoveCode: string;
  CustomerEmail: string;
}

export function ecpayBuyerFields(buyer: InvoiceBuyer, customerEmail: string): EcpayBuyerFields {
  const norm = normalizeInvoiceBuyer(buyer);
  if (!norm.ok) {
    throw new InvoiceRuleError('Invoice buyer must be valid and normalised');
  }

  // Check that buyer was ALREADY normalised
  const normBuyer = norm.buyer;
  if (normBuyer.type !== buyer.type) {
    throw new InvoiceRuleError('Invoice buyer must be valid and normalised');
  }

  switch (normBuyer.type) {
    case 'member_carrier': {
      if (Object.keys(buyer).length !== 1) {
        throw new InvoiceRuleError('Invoice buyer contains extra properties');
      }
      break;
    }
    case 'mobile_barcode': {
      if (Object.keys(buyer).length !== 2 || (buyer as any).barcode !== normBuyer.barcode) {
        throw new InvoiceRuleError('Invoice buyer must be already normalised');
      }
      break;
    }
    case 'citizen_cert': {
      if (Object.keys(buyer).length !== 2 || (buyer as any).certificate !== normBuyer.certificate) {
        throw new InvoiceRuleError('Invoice buyer must be already normalised');
      }
      break;
    }
    case 'donation': {
      if (Object.keys(buyer).length !== 2 || (buyer as any).loveCode !== normBuyer.loveCode) {
        throw new InvoiceRuleError('Invoice buyer must be already normalised');
      }
      break;
    }
    case 'company': {
      const b = buyer as { type: 'company'; ubn: string; title: string; barcode?: string };
      if (b.ubn !== normBuyer.ubn || b.title !== normBuyer.title || b.barcode !== normBuyer.barcode) {
        throw new InvoiceRuleError('Invoice buyer must be already normalised');
      }
      const expectedKeys = normBuyer.barcode !== undefined ? 4 : 3;
      if (Object.keys(buyer).length !== expectedKeys) {
        throw new InvoiceRuleError('Invoice buyer contains unexpected properties');
      }
      break;
    }
  }

  if (!isInvoiceEmail(customerEmail)) {
    throw new InvoiceRuleError('Invalid customer email');
  }

  switch (normBuyer.type) {
    case 'member_carrier':
      return {
        CustomerIdentifier: '',
        CustomerName: '',
        CarrierType: '1',
        CarrierNum: '',
        Print: '0',
        Donation: '0',
        LoveCode: '',
        CustomerEmail: customerEmail,
      };

    case 'mobile_barcode':
      return {
        CustomerIdentifier: '',
        CustomerName: '',
        CarrierType: '3',
        CarrierNum: normBuyer.barcode,
        Print: '0',
        Donation: '0',
        LoveCode: '',
        CustomerEmail: customerEmail,
      };

    case 'citizen_cert':
      return {
        CustomerIdentifier: '',
        CustomerName: '',
        CarrierType: '2',
        CarrierNum: normBuyer.certificate,
        Print: '0',
        Donation: '0',
        LoveCode: '',
        CustomerEmail: customerEmail,
      };

    case 'donation':
      return {
        CustomerIdentifier: '',
        CustomerName: '',
        CarrierType: '',
        CarrierNum: '',
        Print: '0',
        Donation: '1',
        LoveCode: normBuyer.loveCode,
        CustomerEmail: customerEmail,
      };

    case 'company':
      return {
        CustomerIdentifier: normBuyer.ubn,
        CustomerName: normBuyer.title,
        CarrierType: normBuyer.barcode ? '3' : '1',
        CarrierNum: normBuyer.barcode ?? '',
        Print: '0',
        Donation: '0',
        LoveCode: '',
        CustomerEmail: customerEmail,
      };
  }
}
