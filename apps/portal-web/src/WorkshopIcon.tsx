import type { TabId } from './types';

// Interface glyphs remain vectors; the original brand artwork is never redrawn.
const paths: Record<TabId, string> = {
  home:'m3 10 9-7 9 7v10H3Zm6 10v-7h6v7',
  positioning:'M12 3v3m0 12v3M3 12h3m12 0h3M8 8l8 8m0-8-8 8',
  guilds:'m12 3 9 4v6c0 4-6 7-9 8-3-1-9-4-9-8V7Zm-4 8 3 3 5-5',
  squads:'M9 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-6 9v-3c0-4 12-4 12 0v3m1-17a4 4 0 0 1 0 8m3 3c2 0 3 1 3 3v3',
  supplier:'m3 7 9-4 9 4-9 4Zm0 0v10l9 4 9-4V7m-9 4v10m-5-16 10 4',
  retail:'M4 10v11h16V10M3 3h18l1 7H2Zm6 18v-7h6v7',
  opensource:'m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18',
  cocreation:'M6 3v12a5 5 0 0 0 5 5h7M6 8h7a5 5 0 0 0 5-5m-3 14 3 3-3 3',
  marketing:'m3 9 16-6v16L3 13Zm3 5 2 7h4l-2-6m12-7v7',
  workbench:'M8 6V3h8v3M3 6h18v15H3Zm0 6h18m-11-2v4h4v-4',
  showcase:'M3 3h18v18H3Zm0 13 6-6 6 6 3-3 3 3M15 7h2',
  engagement:'M5 3h14v18H5Zm4 5h6m-6 4h6m-6 4h4',
  community:'M21 11a9 9 0 1 0-16 6l-2 4 6-2a9 9 0 0 0 12-8ZM8 11h.1m4 0h.1m4 0h.1',
  account:'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-8 9v-2c0-6 16-6 16 0v2',
  members:'M9 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-6 9v-3c0-4 12-4 12 0v3m5-13v8m-4-4h8',
};
export function WorkshopIcon({ name }: { name: TabId }) {
  return <svg className="workshop-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={paths[name]}/></svg>;
}
