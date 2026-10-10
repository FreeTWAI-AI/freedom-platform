import type {Pool} from 'pg';
import {listEventOutcomeBacklinks,type EventOutcomeRef,type EventOutcomeViewer} from './event-outcomes.js';
const escape=(value:string)=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
export async function eventOutcomeBacklinksHtml(pool:Pick<Pool,'query'>,ref:EventOutcomeRef,viewer:EventOutcomeViewer|null=null){
 const {items}=await listEventOutcomeBacklinks(pool,ref,viewer);
 return items.length?`<section aria-label="來自哪場活動"><h2>來自哪場活動</h2><ul>${items.map(item=>`<li><a href="${escape(item.path.startsWith('#')?'/'+item.path:item.path)}">${escape(item.event_title)} · ${escape(item.title)}</a></li>`).join('')}</ul></section>`:'';
}
