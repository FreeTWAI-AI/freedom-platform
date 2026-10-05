/** One persisted choice controls presentation and its optional guide pack. */
export type BaseTheme = 'light' | 'dark' | 'versefolk';
export type GuidePackId = 'dragon' | 'ai-sister';
export type WorkshopTheme = BaseTheme | 'guide-dragon' | 'guide-ai-sister';
export type ExperienceProfile = {id: WorkshopTheme; label: string; baseTheme: BaseTheme; skin: GuidePackId | null; guidePack: GuidePackId | null};
export const EXPERIENCE_PROFILES = {
  light: {id:'light',label:'自由工坊－明亮',baseTheme:'light',skin:null,guidePack:null},
  dark: {id:'dark',label:'自由工坊－夜航',baseTheme:'dark',skin:null,guidePack:null},
  versefolk: {id:'versefolk',label:'自由工坊－敘生',baseTheme:'versefolk',skin:null,guidePack:null},
  'guide-dragon': {id:'guide-dragon',label:'新手導覽－龍娘',baseTheme:'dark',skin:'dragon',guidePack:'dragon'},
  'guide-ai-sister': {id:'guide-ai-sister',label:'新手導覽－AI Sister',baseTheme:'light',skin:'ai-sister',guidePack:'ai-sister'},
} as const satisfies Record<WorkshopTheme, ExperienceProfile>;
export const WORKSHOP_THEMES = Object.values(EXPERIENCE_PROFILES).map(profile => [profile.id,profile.label] as const);
export function resolveExperienceProfile(value: unknown): ExperienceProfile {
  return typeof value==='string' && Object.hasOwn(EXPERIENCE_PROFILES,value)
    ? EXPERIENCE_PROFILES[value as WorkshopTheme] : EXPERIENCE_PROFILES.light;
}
export function applyExperienceProfile(value: unknown, root: HTMLElement = document.documentElement): WorkshopTheme {
  const profile=resolveExperienceProfile(value);
  root.dataset.theme=profile.baseTheme;
  root.dataset.experienceProfile=profile.id;
  if(profile.skin)root.dataset.guideSkin=profile.skin;else delete root.dataset.guideSkin;
  return profile.id;
}
export function initializeExperienceProfile(storage?: Pick<Storage,'getItem'> | null): WorkshopTheme {
  try { return applyExperienceProfile((storage===undefined ? localStorage : storage)?.getItem('freedom-theme')); }
  catch { return applyExperienceProfile('light'); }
}
