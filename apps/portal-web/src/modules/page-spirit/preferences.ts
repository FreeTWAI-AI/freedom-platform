export interface SpiritPreferences { energy: boolean; instantText: boolean }
export const SPIRIT_PREFERENCES_KEY = 'freedom-page-spirit-ui-v1'
const defaults = (): SpiritPreferences => ({energy: false, instantText: false})
type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>

function browserStorage(): PreferenceStorage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage }
  catch { return null }
}

export function readSpiritPreferences(storage: Pick<PreferenceStorage, 'getItem'> | null = browserStorage()): SpiritPreferences {
  try {
    const value: unknown = JSON.parse(storage?.getItem(SPIRIT_PREFERENCES_KEY) ?? 'null')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return defaults()
    const record = value as Record<string, unknown>
    return {energy: record.energy === true, instantText: record.instantText === true}
  } catch { return defaults() }
}

export function writeSpiritPreferences(value: SpiritPreferences, storage: Pick<PreferenceStorage, 'setItem'> | null = browserStorage()): void {
  try {
    storage?.setItem(SPIRIT_PREFERENCES_KEY, JSON.stringify({energy: value.energy === true, instantText: value.instantText === true}))
  } catch { /* A blocked or full storage must not prevent using the helper. */ }
}
