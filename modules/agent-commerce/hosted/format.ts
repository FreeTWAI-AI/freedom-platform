/** Same integer-minor display convention as the portal; conformance values are tested. */
export function formatMinor(amountMinor: string | number, currency: string): string {
  const raw = String(amountMinor).trim()
  if (!/^-?\d+$/.test(raw)) return '金額無法顯示'
  const negative = raw.startsWith('-')
  const digits = (negative ? raw.slice(1) : raw).replace(/^0+(?=\d)/, '') || '0'
  const padded = digits.padStart(3, '0')
  const whole = padded.slice(0, -2)
  const cents = padded.slice(-2)
  const value = Number(`${negative ? '-' : ''}${whole}.${cents}`)
  try {
    return new Intl.NumberFormat('zh-TW', {
      style: 'currency',
      currency: currency || 'TWD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value)
  } catch {
    return `${currency} ${negative ? '-' : ''}${whole}.${cents}`
  }
}

