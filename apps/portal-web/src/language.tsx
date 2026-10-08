import {createContext,useContext,useEffect,useMemo,useState,type ReactNode} from 'react';
import {interfaceMessages,type InterfaceMessage} from './interface-messages';

export const LANGUAGES=[['zh-Hant','繁體中文'],['en','English'],['ja','日本語'],['ko','한국어'],['es','Español']] as const;
export type InterfaceLanguage=typeof LANGUAGES[number][0];
export type LanguagePreference='auto'|InterfaceLanguage;
export const LANGUAGE_STORAGE_KEY='freedom-interface-language-v1';
const languageIndex:Record<InterfaceLanguage,number>={'zh-Hant':0,en:1,ja:2,ko:3,es:4};
const validPreference=(value:unknown):value is LanguagePreference=>value==='auto'||LANGUAGES.some(([language])=>language===value);
function browserLanguage():InterfaceLanguage{
  for(const raw of navigator.languages?.length?navigator.languages:[navigator.language]){
    const code=raw.toLowerCase().split('-')[0];
    if(code==='zh')return 'zh-Hant';
    if(code==='en'||code==='ja'||code==='ko'||code==='es')return code;
  }
  return 'en';
}
function storedPreference():LanguagePreference{
  try{const value=localStorage.getItem(LANGUAGE_STORAGE_KEY);if(validPreference(value))return value;}catch{/* Storage may be disabled. */}
  return 'auto';
}
export function interfaceText(language:InterfaceLanguage,key:InterfaceMessage,values:Record<string,string|number>={}){
  const text=interfaceMessages[key][languageIndex[language]];
  return text.replace(/\{([a-zA-Z]+)\}/g,(match,name)=>Object.hasOwn(values,name)?String(values[name]):match);
}
type LanguageContext={language:InterfaceLanguage;preference:LanguagePreference;selectLanguage:(preference:LanguagePreference)=>void;t:(key:InterfaceMessage,values?:Record<string,string|number>)=>string};
const Context=createContext<LanguageContext>({language:'zh-Hant',preference:'zh-Hant',selectLanguage:()=>{},t:(key,values)=>interfaceText('zh-Hant',key,values)});

/** Device-local, non-secret preference. Language changes never remount a form. */
export function LanguageProvider({children}:{children:ReactNode}){
  const [preference,setPreference]=useState<LanguagePreference>(storedPreference),[detected,setDetected]=useState(browserLanguage);
  const language=preference==='auto'?detected:preference;
  useEffect(()=>{
    const sync=()=>setDetected(browserLanguage());
    const storage=(event:StorageEvent)=>{if(event.key===LANGUAGE_STORAGE_KEY||event.key===null)setPreference(storedPreference());};
    window.addEventListener('languagechange',sync);window.addEventListener('storage',storage);
    return()=>{window.removeEventListener('languagechange',sync);window.removeEventListener('storage',storage);};
  },[]);
  useEffect(()=>{document.documentElement.lang=language;},[language]);
  const value=useMemo<LanguageContext>(()=>({language,preference,selectLanguage(next){
    if(!validPreference(next))return;setPreference(next);
    try{if(next==='auto')localStorage.removeItem(LANGUAGE_STORAGE_KEY);else localStorage.setItem(LANGUAGE_STORAGE_KEY,next);}catch{/* Keep the usable in-memory choice. */}
  },t:(key,values)=>interfaceText(language,key,values)}),[language,preference]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export const useLanguage=()=>useContext(Context);
export function LanguagePicker({className='',showScope=false}:{className?:string;showScope?:boolean}){
  const {preference,selectLanguage,t}=useLanguage();
  return <div className={`language-picker ${className}`}><label><span lang="en">Language</span><select aria-label="Language" value={preference} onChange={event=>selectLanguage(event.target.value as LanguagePreference)}>
    <option value="auto">{t('language.auto')}</option>{LANGUAGES.map(([id,name])=><option key={id} value={id} lang={id}>{name}</option>)}
  </select></label>{showScope&&<p className="field-hint">{t('language.scope')}</p>}</div>;
}
