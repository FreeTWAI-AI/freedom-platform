import { InvoiceRuleError, assertMinorMoney } from './errors.js';

export interface InvoiceItem {
  name: string;
  count: number;
  priceMinor: number;
  amountMinor: number;
}

export interface SplitUnitPart {
  count: number;
  priceMinor: number;
  lumped?: boolean;
}

export interface EcpayItemRow {
  ItemSeq: number;
  ItemName: string;
  ItemCount: number;
  ItemWord: string;
  ItemPrice: number;
  ItemAmount: number;
}

/**
 * Normalises and truncates an item name according to ECPay 100 code-point limits.
 */
export function itemName(productName: string, variantLabel?: string | null, suffix?: string): string {
  if (typeof productName !== 'string') {
    throw new InvoiceRuleError('Product name must be a string');
  }

  const cleanProduct = productName
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleanProduct.length === 0) {
    throw new InvoiceRuleError('Product name cannot be empty');
  }

  let base = cleanProduct;
  if (variantLabel !== undefined && variantLabel !== null) {
    if (typeof variantLabel !== 'string') {
      throw new InvoiceRuleError('Variant label must be a string');
    }
    const cleanVariant = variantLabel
      .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleanVariant.length > 0) {
      base = `${cleanProduct}（${cleanVariant}）`;
    }
  }

  const suffixStr = suffix ?? '';
  if (typeof suffixStr !== 'string') {
    throw new InvoiceRuleError('Suffix must be a string');
  }

  const suffixCodePoints = Array.from(suffixStr);
  const suffixLen = suffixCodePoints.length;
  const budget = 100 - suffixLen;

  if (budget < 1) {
    throw new InvoiceRuleError('Suffix too long to fit in 100 code points');
  }

  const baseCodePoints = Array.from(base);
  let finalBase = base;
  if (baseCodePoints.length > budget) {
    if (budget < 2) {
      throw new InvoiceRuleError('Budget too small to fit truncation ellipsis');
    }
    finalBase = baseCodePoints.slice(0, budget - 1).join('') + '…';
  }

  return finalBase + suffixStr;
}

/**
 * Splits an amount in minor units into whole NT$ units.
 */
export function splitUnits(amountMinor: number, quantity: number): SplitUnitPart[] {
  assertMinorMoney(amountMinor);
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 99) {
    throw new InvoiceRuleError('Quantity must be an integer between 1 and 99');
  }

  if (amountMinor === 0) {
    return [];
  }

  const n = amountMinor / 100;
  const Q = quantity;
  const base = Math.floor(n / Q);
  const r = n - base * Q;

  if (base >= 1) {
    if (r === 0) {
      return [{ count: Q, priceMinor: base * 100 }];
    }
    return [
      { count: Q - r, priceMinor: base * 100 },
      { count: r, priceMinor: (base + 1) * 100 },
    ];
  }

  // base === 0: lumped part
  return [{ count: 1, priceMinor: amountMinor, lumped: true }];
}

export function invoiceItems(input: {
  lines: Array<{
    productName: string;
    variantLabel?: string | null;
    quantity: number;
    netMinor: number;
  }>;
  shippingGroups: Array<{ feeMinor: number }>;
}): { items: InvoiceItem[]; salesMinor: number } {
  if (!input || !Array.isArray(input.lines) || !Array.isArray(input.shippingGroups)) {
    throw new InvoiceRuleError('Invalid invoice lines or shipping groups input');
  }

  if (input.lines.length < 1 || input.lines.length > 50) {
    throw new InvoiceRuleError('Invoice lines count must be between 1 and 50');
  }

  if (input.shippingGroups.length > 50) {
    throw new InvoiceRuleError('Shipping groups count cannot exceed 50');
  }

  const items: InvoiceItem[] = [];

  for (const line of input.lines) {
    assertMinorMoney(line.netMinor);
    if (!Number.isSafeInteger(line.quantity) || line.quantity < 1 || line.quantity > 99) {
      throw new InvoiceRuleError('Line quantity must be between 1 and 99');
    }

    if (line.netMinor === 0) {
      continue;
    }

    const parts = splitUnits(line.netMinor, line.quantity);
    for (const part of parts) {
      const name = part.lumped
        ? itemName(line.productName, line.variantLabel, `（共${line.quantity}件）`)
        : itemName(line.productName, line.variantLabel);
      const amountMinor = part.count * part.priceMinor;
      items.push({
        name,
        count: part.count,
        priceMinor: part.priceMinor,
        amountMinor,
      });
    }
  }

  for (const group of input.shippingGroups) {
    assertMinorMoney(group.feeMinor);
    if (group.feeMinor > 0) {
      items.push({
        name: '運費',
        count: 1,
        priceMinor: group.feeMinor,
        amountMinor: group.feeMinor,
      });
    }
  }

  const salesMinor = items.reduce((sum, item) => sum + item.amountMinor, 0);
  if (salesMinor <= 0) {
    throw new InvoiceRuleError('Total invoice sales amount must be greater than 0');
  }

  return { items, salesMinor };
}

export function allowanceItems(input: {
  refundLines: Array<
    | {
        kind: 'item';
        productName: string;
        variantLabel?: string | null;
        quantity: number;
        amountMinor: number;
      }
    | { kind: 'shipping'; amountMinor: number }
    | { kind: 'unapplied'; amountMinor: number }
  >;
}): { items: InvoiceItem[]; allowanceMinor: number } {
  if (!input || !Array.isArray(input.refundLines)) {
    throw new InvoiceRuleError('Invalid refund lines input');
  }

  const items: InvoiceItem[] = [];

  for (const line of input.refundLines) {
    if (line.kind === 'unapplied') {
      throw new InvoiceRuleError('Unapplied refunds cannot touch an invoice');
    }

    assertMinorMoney(line.amountMinor);
    if (line.amountMinor === 0) {
      continue;
    }

    if (line.kind === 'item') {
      if (!Number.isSafeInteger(line.quantity) || line.quantity < 0 || line.quantity > 99) {
        throw new InvoiceRuleError('Item refund quantity must be between 0 and 99');
      }

      if (line.quantity === 0) {
        // Price difference only
        const name = itemName(line.productName, line.variantLabel, '（折讓）');
        items.push({
          name,
          count: 1,
          priceMinor: line.amountMinor,
          amountMinor: line.amountMinor,
        });
      } else {
        const parts = splitUnits(line.amountMinor, line.quantity);
        for (const part of parts) {
          const name = part.lumped
            ? itemName(line.productName, line.variantLabel, `（共${line.quantity}件）`)
            : itemName(line.productName, line.variantLabel);
          items.push({
            name,
            count: part.count,
            priceMinor: part.priceMinor,
            amountMinor: part.count * part.priceMinor,
          });
        }
      }
    } else if (line.kind === 'shipping') {
      items.push({
        name: '運費',
        count: 1,
        priceMinor: line.amountMinor,
        amountMinor: line.amountMinor,
      });
    } else {
      throw new InvoiceRuleError('Unknown refund line kind');
    }
  }

  const allowanceMinor = items.reduce((sum, item) => sum + item.amountMinor, 0);
  if (allowanceMinor <= 0) {
    throw new InvoiceRuleError('Total allowance amount must be greater than 0');
  }

  if (items.length > 200) {
    throw new InvoiceRuleError('Allowance items count cannot exceed 200');
  }

  return { items, allowanceMinor };
}

export function toEcpayItems(items: InvoiceItem[], itemWord: string): EcpayItemRow[] {
  if (!Array.isArray(items) || items.length < 1 || items.length > 200) {
    throw new InvoiceRuleError('Items count must be between 1 and 200');
  }

  if (typeof itemWord !== 'string') {
    throw new InvoiceRuleError('ItemWord must be a string');
  }

  const cleanWord = itemWord.trim();
  const wordLen = Array.from(cleanWord).length;
  if (wordLen < 1 || wordLen > 6) {
    throw new InvoiceRuleError('ItemWord code points must be between 1 and 6');
  }

  return items.map((item, idx) => {
    if (!item || typeof item.name !== 'string') {
      throw new InvoiceRuleError('Item name must be a string');
    }
    const nameLen = Array.from(item.name).length;
    if (nameLen < 1 || nameLen > 100) {
      throw new InvoiceRuleError('Item name code points must be between 1 and 100');
    }
    if (!Number.isSafeInteger(item.count) || item.count < 1 || item.count > 99) {
      throw new InvoiceRuleError('Item count must be an integer between 1 and 99');
    }
    assertMinorMoney(item.priceMinor);
    assertMinorMoney(item.amountMinor);
    if (item.priceMinor <= 0 || item.amountMinor <= 0) {
      throw new InvoiceRuleError('Item price and amount must be positive');
    }
    if (item.count * item.priceMinor !== item.amountMinor) {
      throw new InvoiceRuleError('Item amount must equal count times price');
    }

    return {
      ItemSeq: idx + 1,
      ItemName: item.name,
      ItemCount: item.count,
      ItemWord: cleanWord,
      ItemPrice: item.priceMinor / 100,
      ItemAmount: item.amountMinor / 100,
    };
  });
}

export function ntdFromMinor(minor: number): number {
  assertMinorMoney(minor);
  return minor / 100;
}

export function invoiceRemark(displayNumber: string): string {
  if (
    typeof displayNumber !== 'string' ||
    !/^[0-9]{6}-[0-9A-HJKMNP-TV-Z]{6}$/.test(displayNumber)
  ) {
    throw new InvoiceRuleError('Invalid order display number');
  }
  return `訂單 ${displayNumber}`;
}
