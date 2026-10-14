import type {SharePlatform} from '../social-share';

// Keep shared artwork independent of the optional sharing panel's lazy module.
export function PlatformLogo({platform}:{platform:SharePlatform}){
  return <svg viewBox="0 0 24 24" width="24" height="24" fill="none" aria-hidden="true" focusable="false">
    {platform==='x'&&<path fill="currentColor" d="M18.9 2H22l-6.8 7.8L23 22h-6.1l-4.8-7.4L5.6 22H2.4l8.2-9.4L1 2h6.3l4.4 6.7L18.9 2ZM17.4 20h1.8L6.2 4H4.3l13.1 16Z"/>}
    {platform==='facebook'&&<path fill="currentColor" d="M13.8 22v-9.1h3l.5-3.5h-3.5V7.2c0-1 .3-1.7 1.8-1.7h1.9V2.4c-.3 0-1.5-.2-2.8-.2-2.8 0-4.7 1.7-4.7 4.8v2.4H7v3.5h3V22h3.8Z"/>}
    {platform==='instagram'&&<g stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none"/></g>}
    {platform==='threads'&&<path d="M19.7 7.8C18.8 3.8 15.6 2 12 2 5.8 2 3.2 6 3.2 12s2.9 10 8.8 10c4.9 0 8.2-2.6 8.2-6.1 0-3-2.6-5.1-6.2-5.1-3.2 0-5.1 1.3-5.1 3.2 0 1.6 1.1 2.6 3 2.6 3.4 0 4.3-2.7 4.3-5.9 0-2.8-1.6-4.5-4.2-4.5-1.8 0-3.3.8-4 2.2" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"/>}
  </svg>;
}
