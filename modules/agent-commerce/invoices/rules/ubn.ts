const UBN_WEIGHTS = [1, 2, 1, 2, 1, 2, 4, 1] as const;

/**
 * Validates a Taiwan Unified Business Number (統一編號, UBN).
 *
 * Source: 財政部財政資訊中心「營利事業統一編號檢查碼邏輯修正說明」
 * (https://www.fia.gov.tw/singlehtml/3?cntId=c4d9cff38c8642ef8872774ee9987283)
 * Effective 2023-04-01 (112年4月1日), the modulus divisor changed from 10 to 5.
 * Note: The weights [1,2,1,2,1,2,4,1] and the 7th-digit rule are the long-standing
 * rule of the same document's attachment, which Claude could not read online —
 * verify against the MOF attachment before release. ECPay re-checks on issue (RtnCode 1200125).
 *
 * @param value Already normalised 8-digit UBN string.
 * @returns true if format and checksum are valid under the 2023 rules.
 */
export function isValidUbn(value: string): boolean {
  if (typeof value !== 'string' || !/^[0-9]{8}$/.test(value)) {
    return false;
  }

  let sum = 0;
  for (let i = 0; i < 8; i++) {
    const digit = Number(value[i]);
    const product = digit * UBN_WEIGHTS[i];
    const tens = Math.floor(product / 10);
    const units = product % 10;
    sum += tens + units;
  }

  if (sum % 5 === 0) {
    return true;
  }

  // When the 7th digit (index 6) is 7, the product 7 * 4 = 28 can alternate
  // between contribution 2+8=10 and 1, which shifts the sum by 1.
  if (value[6] === '7' && (sum + 1) % 5 === 0) {
    return true;
  }

  return false;
}
