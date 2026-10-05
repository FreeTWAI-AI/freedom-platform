import {useEffect,useState} from 'react';
import {applyExperienceProfile,resolveExperienceProfile,type WorkshopTheme} from './experience-profiles';
export {WORKSHOP_THEMES,resolveExperienceProfile} from './experience-profiles';
export type {WorkshopTheme} from './experience-profiles';
function currentTheme():WorkshopTheme {
  return resolveExperienceProfile(document.documentElement.dataset.experienceProfile ?? document.documentElement.dataset.theme).id;
}
export function useWorkshopTheme(){
  const [theme,setTheme]=useState<WorkshopTheme>(currentTheme);
  useEffect(()=>{
    const sync=()=>setTheme(currentTheme());
    const storage=(event:StorageEvent)=>{if(event.key==='freedom-theme'){applyExperienceProfile(event.newValue);sync();}};
    window.addEventListener('freedom-theme-changed',sync);window.addEventListener('storage',storage);
    return()=>{window.removeEventListener('freedom-theme-changed',sync);window.removeEventListener('storage',storage)};
  },[]);
  function selectTheme(next:WorkshopTheme){
    const selected=applyExperienceProfile(next);setTheme(selected);
    try{localStorage.setItem('freedom-theme',selected)}catch{/* Current visit retains the choice. */}
    window.dispatchEvent(new Event('freedom-theme-changed'));
  }
  return {theme,selectTheme};
}
