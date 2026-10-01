import {useEffect,useState} from 'react';
import type {PortalClient} from '../api';
import {SkillBookIntro,type IntroBook} from './SkillBookIntro';
export function EntryResources({client}:{client:PortalClient}){
  const [books,setBooks]=useState<IntroBook[]>([]),[error,setError]=useState(false),[opened,setOpened]=useState(false),[revision,setRevision]=useState(0);
  useEffect(()=>{if(!opened||books.length)return;let active=true;setError(false);void client.get<{skill_books:IntroBook[]}>('/community',{background:true}).then(value=>{if(active)setBooks(value.skill_books.slice(0,3))}).catch(()=>{if(active)setError(true)});return()=>{active=false}},[client,opened,revision,books.length]);
  return <div className="entry-resources"><p>把你的專長與資源，變成夥伴能一起完成的作品。</p><ul className="entry-benefits"><li>免費學習資源</li><li>同領域夥伴</li><li>真實合作機會</li></ul><details onToggle={event=>setOpened(event.currentTarget.open)}><summary>先看免費資源，不用註冊</summary><div className="entry-resource-list">{books.map(book=><article key={book.id??book.book_id}><strong>{book.title}</strong><SkillBookIntro book={book} label="免費預覽"/></article>)}{!books.length&&<p role="status">{error?'資源暫時無法載入。':'正在整理可預覽的資源…'}</p>}{error&&<button type="button" className="btn btn-ghost" onClick={()=>setRevision(value=>value+1)}>重新讀取資源</button>}</div></details></div>;
}
