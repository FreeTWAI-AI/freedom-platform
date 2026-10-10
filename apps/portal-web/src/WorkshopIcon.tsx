import type { TabId } from './types';

// Interface glyphs remain vectors; the original brand artwork is never redrawn.
const paths: Record<TabId, string> = {
  'community-search':'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm6-2 5 5',
  'my-content':'M5 3h10l4 4v14H5Zm10 0v5h4M8 12h8m-8 4h6',
  'private-ai':'M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5Zm7 4v3',
  skills:'M3 4h7v17H3Zm10 0h4l4 16-4 1ZM6 8h1m-1 9h1',
  'guild-workspace':'M4 3h16v12H4Zm4 5h8m-8 3h5m-7 4v6l6-3 6 3v-6',
  reservations:'M5 3h14v18H5Zm4 5h6m-6 4h6m-6 4h4',
  stores:'M4 10v11h16V10M3 3h18l1 7H2Zm6 18v-7h6v7',
  business:'M4 7h16v13H4Zm0 4h16M9 7V5h6v2',
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
  todos:'M9 6h11M9 12h11M9 18h11M3 6l1 1 2-2M3 12l1 1 2-2M3 18l1 1 2-2',
  messages:'M4 5h16v11H9l-5 4Zm4 5h8',
  friends:'M9 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-6 9v-3c0-4 12-4 12 0v3m2-11 2 2 4-4',
  members:'M9 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-6 9v-3c0-4 12-4 12 0v3m5-13v8m-4-4h8',
  events:'M4 5h16v16H4Zm0 5h16M8 3v4m8-4v4m-8 7h3m3 0h2',
  tasks:'M5 4h14v16H5Zm3 5 1 1 2-2m2 1h4m-9 6 1 1 2-2m2 1h4',
  social:'M15 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm9 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6M8.6 10.6 12.4 8M8.6 13.4l3.8 2.2',
  services:'M4 7h16v13H4Zm0 4h16M8 7V5a4 4 0 0 1 8 0v2',
  promotion:'M4 20V10m8 10V4m8 16v-7',
  highlights:'M4 8h11v11H4Zm5-4h13v11M8 13.5l4-2.2v4.4Z',
};
export function WorkshopIcon({ name }: { name: TabId }) {
  return <svg className="workshop-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={paths[name]}/></svg>;
}
