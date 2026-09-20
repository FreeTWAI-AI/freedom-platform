const DATETIME_LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$/
const MAJOR_MONEY = /^\d+(\.\d{1,2})?$/

export function formatIsoLocal(iso: string | null | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return new Intl.DateTimeFormat('zh-TW', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

export function toLocalInput(isoOrDate: string | Date): string {
  const date = typeof isoOrDate === 'string' ? new Date(isoOrDate) : isoOrDate
  if (Number.isNaN(date.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function hoursFromNowLocalInput(hours: number): string {
  return toLocalInput(new Date(Date.now() + hours * 60 * 60 * 1000))
}

export function localInputToIso(value: string): string {
  const trimmed = value.trim()
  if (!DATETIME_LOCAL.test(trimmed)) {
    throw new Error('請選擇完整的日期與時間')
  }
  const date = new Date(trimmed)
  if (Number.isNaN(date.getTime())) {
    throw new Error('日期時間無效')
  }
  return date.toISOString()
}

export function isPastIso(iso: string | null | undefined): boolean {
  if (!iso) return false
  const time = Date.parse(iso)
  return !Number.isNaN(time) && time < Date.now()
}

export function parseMajorToMinor(input: string): number {
  const trimmed = input.trim().replace(/,/g, '')
  if (!trimmed) throw new Error('請輸入金額')
  if (!MAJOR_MONEY.test(trimmed)) {
    throw new Error('金額須為非負數字，最多兩位小數；無效數字會被拒絕，不會四捨五入')
  }
  const [whole, frac = ''] = trimmed.split('.')
  const minor = BigInt(whole) * 100n + BigInt((frac + '00').slice(0, 2))
  if (minor <= 0n) throw new Error('金額須大於 0')
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('金額過大')
  return Number(minor)
}

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

export function participationModeLabel(mode: string | undefined): string {
  switch (mode) {
    case 'voluntary_contribution':
      return '自願貢獻'
    case 'bounded_mutual_help':
      return '有限互助'
    case 'funded_work':
      return '有預算工作'
    default:
      return mode || '未標示'
  }
}

export function claimStateLabel(state: string): string {
  switch (state) {
    case 'claimed':
      return '已認領'
    case 'in_progress':
      return '進行中'
    case 'submitted':
      return '已提交'
    case 'in_review':
      return '回饋中'
    case 'changes_requested':
      return '需調整'
    case 'accepted':
      return '已接受'
    default:
      return state
  }
}

export function workStateLabel(state: string): string {
  switch (state) {
    case 'open':
      return '開放認領'
    case 'claimed':
    case 'claiming_closed':
      return '已有認領'
    case 'completed':
    case 'accepted':
      return '已完成'
    default:
      return state
  }
}

export function engagementStateLabel(state: string): string {
  switch (state) {
    case 'proposed':
      return '待同意'
    case 'agreed':
      return '已同意'
    case 'delivered':
      return '已交付'
    case 'accepted':
      return '交付已接受'
    default:
      return state
  }
}

export function opportunityStateLabel(state: string): string {
  switch (state) {
    case 'open':
      return '待提出合作'
    case 'proposed':
      return '已提出合作'
    default:
      return state
  }
}

export function looksLikeUrl(value: string): boolean {
  return /:\/\//.test(value) || /^https?:/i.test(value.trim())
}
