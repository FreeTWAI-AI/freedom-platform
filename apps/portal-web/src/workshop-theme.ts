import {useEffect,useState} from 'react';

export type WorkshopTheme='light'|'dark'|'versefolk';
export const WORKSHOP_THEMES=[
  ['light','自由工坊－明亮'],
  ['dark','自由工坊－夜航'],
  ['versefolk','自由工坊－敘生'],
] as const satisfies readonly (readonly [WorkshopTheme,string])[];

function currentTheme():WorkshopTheme{
  const selected=document.documentElement.dataset.theme;
  return selected==='dark'||selected==='versefolk'?selected:'light';
}

export function useWorkshopTheme(){
  const [theme,setTheme]=useState<WorkshopTheme>(currentTheme);
  useEffect(()=>{const sync=()=>setTheme(currentTheme());window.addEventListener('freedom-theme-changed',sync);return()=>window.removeEventListener('freedom-theme-changed',sync)},[]);
  function selectTheme(next:WorkshopTheme){
    document.documentElement.dataset.theme=next;
    setTheme(next);
    try{localStorage.setItem('freedom-theme',next)}catch{/* The current visit still uses the selected theme. */}
    window.dispatchEvent(new Event('freedom-theme-changed'));
  }
  return {theme,selectTheme};
}
