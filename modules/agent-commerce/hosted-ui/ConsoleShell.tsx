import type {ReactNode} from 'react';
import './ConsoleShell.css';

/** One navigation entry; `href` is a full hash such as `#stores/<t>/<i>/supply/products`. */
export type ConsoleNavItem={key:string;label:string;group:string;href:string};

/**
 * Shared frame of the private supplier and seller consoles: grouped side navigation that turns into a select on
 * narrow screens, beside one content column. Each console keeps its own routes, reads, commands, leave guard and
 * page content. Entries are plain hash links, so the App hash guard still decides every navigation.
 */
export function ConsoleShell({label,selectLabel,groups,items,current,enabled=true,disabledReason,children}:{
 label:string;selectLabel:string;groups:readonly string[];items:readonly ConsoleNavItem[];
 /** Selected entry; `title` names the current page in the select when it has no entry of its own. */
 current:{key:string;title:string};
 /** False before setup is complete: entries render as disabled text explained by `disabledReason`. */
 enabled?:boolean;disabledReason?:string;children:ReactNode;
}){
 const selected=items.find(item=>item.key===current.key),grouped=groups.map(group=>({group,entries:items.filter(item=>item.group===group)}));
 return <div className="console-layout">
  <nav className="console-nav" aria-label={label}>{grouped.map(({group,entries})=><div className="console-nav-group" key={group}><p>{group}</p>{entries.map(item=>enabled?<a key={item.key} href={item.href} aria-current={item===selected?'page':undefined}>{item.label}</a>:<span key={item.key} aria-disabled="true" title={disabledReason}>{item.label}</span>)}</div>)}</nav>
  <label className="console-mobile-nav field">{selectLabel}<select disabled={!enabled} value={selected?.href??''} onChange={event=>{window.location.hash=event.target.value;}}>{!selected&&<option value="" disabled>{current.title}</option>}{grouped.map(({group,entries})=><optgroup key={group} label={group}>{entries.map(item=><option key={item.key} value={item.href}>{item.label}</option>)}</optgroup>)}</select></label>
  <div className="console-content">{children}</div>
 </div>;
}
