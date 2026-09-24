import { useId, useState } from 'react';
export type Choice = {id:string;label:string};
export type ChoiceCategory = {id:string;label:string;options:Choice[];subcategories?:{id:string;label:string;options:Choice[]}[]};
export function CapabilityTree({categories,values,onToggle,kind}:{categories:ChoiceCategory[];values:string[];onToggle:(id:string)=>void;kind:'能力'|'裝備'}){
  // Every width starts collapsed and screen size never resets what the member opened.
  // Search reveals matches through its own overrides, so clearing it restores the member's open sections.
  const uid=useId(),[search,setSearch]=useState(''),[opened,setOpened]=useState<Record<string,boolean>>({}),[searchOpened,setSearchOpened]=useState<Record<string,boolean>>({});
  const term=search.trim().toLocaleLowerCase();
  const isOpen=(id:string)=>term?searchOpened[id]??true:!!opened[id];
  const toggle=(id:string)=>(term?setSearchOpened:setOpened)(current=>({...current,[id]:!isOpen(id)}));
  const filtered=categories.map(category=>({...category,groups:(category.subcategories?.length?category.subcategories:[{id:'all',label:category.label,options:category.options}]).map(group=>({...group,options:group.options.filter(option=>`${category.label} ${group.label} ${option.label}`.toLocaleLowerCase().includes(term))})).filter(group=>group.options.length)})).filter(category=>category.groups.length);
  return <div className="capability-tree"><label className="field">搜尋{kind}<input type="search" value={search} onChange={event=>{setSearch(event.target.value);setSearchOpened({});}} placeholder={kind==='能力'?'例如：設計、餐飲、Python、溝通…':'例如：Claude、剪輯、設計、專案管理…'}/></label><p className="field-hint" role="status">已勾選 {values.length} 項{kind}。不確定的項目可以先略過，以後再補。</p>{filtered.map(category=>{
    const categoryId=`${uid}-${category.id}`,categoryOpen=isOpen(category.id);
    return <section key={category.id} className="category-group"><button type="button" className="tree-toggle" aria-expanded={categoryOpen} aria-controls={categoryId} onClick={()=>toggle(category.id)}><strong>{category.label}</strong><span>{category.options.filter(option=>values.includes(option.id)).length} / {category.options.length} <span aria-hidden="true">{categoryOpen?'−':'＋'}</span></span></button><div id={categoryId} hidden={!categoryOpen} className="tree-subcategories">{category.groups.map(group=>{
      const key=`${category.id}/${group.id}`,groupId=`${uid}-${category.id}-${group.id}`,groupOpen=isOpen(key);
      return <section className="tree-subcategory" key={group.id}><button type="button" className="tree-toggle tree-subtoggle" aria-expanded={groupOpen} aria-controls={groupId} onClick={()=>toggle(key)}><span>{group.label}</span><span>{group.options.filter(option=>values.includes(option.id)).length} 已選 <span aria-hidden="true">{groupOpen?'−':'＋'}</span></span></button><div id={groupId} hidden={!groupOpen}><div className="selection-chips">{group.options.map(option=><label key={option.id} className={values.includes(option.id)?'selection-chip selected':'selection-chip'}><input type="checkbox" checked={values.includes(option.id)} onChange={()=>onToggle(option.id)}/>{option.label}</label>)}</div></div></section>;
    })}</div></section>;
  })}{!filtered.length&&<p className="muted">找不到符合的項目。換個關鍵字，或在下方補上你自己的{kind}。</p>}</div>;
}
export function CustomChoices({kind,values,onChange}:{kind:'能力'|'裝備';values:string[];onChange:(values:string[])=>void}){
  const [value,setValue]=useState(''),[error,setError]=useState('');
  function add(){const trimmed=value.trim();if(!trimmed)return;if(values.includes(trimmed)){setError('這一項已經在清單中。');return;}if(values.length>=10){setError('最多可以自行補充 10 項。');return;}onChange([...values,trimmed]);setValue('');setError('');}
  return <section className="custom-choices stack"><h3>補上你自己的{kind}</h3><p className="field-hint">清單沒有的也可以填。每項最多 60 字，最多 10 項；請勿填入密碼或其他機密。</p><div className="custom-choice-input"><label className="field">自訂{kind}<input maxLength={60} value={value} onChange={event=>setValue(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();add();}}}/></label><button type="button" className="btn btn-ghost" disabled={!value.trim()||values.length>=10} onClick={add}>加入{kind}</button></div>{error&&<p role="alert" className="field-hint">{error}</p>}<div className="tag-list">{values.map(item=><span className="custom-choice pill" key={item}>{item}<button type="button" aria-label={`移除${kind}：${item}`} onClick={()=>onChange(values.filter(v=>v!==item))}>×</button></span>)}</div></section>;
}
