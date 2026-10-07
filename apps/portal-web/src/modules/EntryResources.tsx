import {useEffect,useState} from 'react';
import type {PortalClient} from '../api';
import {SkillBookIntro,type IntroBook} from './SkillBookIntro';
import {useLanguage} from '../language';
export function EntryResources({client}:{client:PortalClient}){
  const {t}=useLanguage();
  const [books,setBooks]=useState<IntroBook[]>([]),[error,setError]=useState(false),[opened,setOpened]=useState(false),[revision,setRevision]=useState(0);
  useEffect(()=>{if(!opened||books.length)return;let active=true;setError(false);void client.get<{skill_books:IntroBook[]}>('/community',{background:true}).then(value=>{if(active)setBooks(value.skill_books.slice(0,3))}).catch(()=>{if(active)setError(true)});return()=>{active=false}},[client,opened,revision,books.length]);
  return <div className="entry-resources"><p>{t('resources.intro')}</p><ul className="entry-benefits"><li>{t('resources.learning')}</li><li>{t('resources.partners')}</li><li>{t('resources.opportunities')}</li></ul><details onToggle={event=>setOpened(event.currentTarget.open)}><summary>{t('resources.open')}</summary><div className="entry-resource-list">{books.map(book=><article key={book.id??book.book_id}><strong>{book.title}</strong><SkillBookIntro book={book} label={t('resources.preview')}/></article>)}{!books.length&&<p role="status">{t(error?'resources.error':'resources.loading')}</p>}{error&&<button type="button" className="btn btn-ghost" onClick={()=>setRevision(value=>value+1)}>{t('resources.retry')}</button>}</div></details></div>;
}
