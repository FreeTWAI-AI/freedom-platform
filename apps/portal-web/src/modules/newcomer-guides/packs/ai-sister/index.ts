import manifest from '../../../../../../../contracts/guide-packs/ai-sister-v1-20261005.json';
import characters from './characters.json';
import {AI_SISTER_PAGE_SUPPORT} from '../../ai-sister-pages';
import {AI_SISTER_RELEASE_PIN} from '../../ai-sister-release-pin';
import {loadPageContent} from '../page-content';
import {PAGE_GUIDES} from '../page-guides';
import {resolveAiSisterCharacter} from '../../character-choice';
import type {GuideCharacter,GuidePack,PageGuideSupport} from '../../contracts';

const assets=new Map(manifest.assets.map(asset=>[asset.logicalId,asset]));
function assetPath(logicalId:string):string{
  const asset=assets.get(logicalId);if(!asset)throw Error('Unregistered guide asset');
  return `/public/guide-packs/${manifest.pack}/${manifest.version}/${asset.sha256}.webp`;
}
const catalog:Readonly<Record<string,GuideCharacter>>=Object.fromEntries(Object.entries(characters).map(([id,character])=>{
  const outfits=character.outfits.map(outfit=>({...outfit,hero:assetPath(outfit.hero),views:outfit.views.map(assetPath),reactions:{wave:assetPath(outfit.reactions.wave),think:assetPath(outfit.reactions.think),cheer:assetPath(outfit.reactions.cheer)}}));
  return [id,{...character,portrait:assetPath(character.portrait),hero:outfits[0].hero,frames:[],views:outfits[0].views,reactions:outfits[0].reactions,outfits}];
}));
const pages:Readonly<Record<string,PageGuideSupport>>=AI_SISTER_PAGE_SUPPORT;
export const AI_SISTER_PACK:GuidePack={
  format:'freedom.newcomer-guide/v1',id:'ai-sister',version:AI_SISTER_RELEASE_PIN.version,engineContractVersion:1,locale:'zh-Hant',label:'AI Sister',
  pages,gallery:Object.values(catalog),
  characterChoices:Object.entries(catalog).map(([id,character])=>({id,label:character.name})),
  galleryInfo:{title:'角色圖鑑',attribution:'AI Sister 角色與素材來自 Ted 的',sourceLabel:'Multi-Ai-Chatapp',sourceUrl:'https://github.com/teddashh/Multi-Ai-Chatapp'},
  async loadPage(pageId,characterId){
    const support=Object.hasOwn(pages,pageId)?pages[pageId]:null;
    if(support?.status!=='supported')throw Error('Unsupported guide page');
    const selected=catalog[resolveAiSisterCharacter(characterId)];
    const outfit=selected.outfits?.find(outfit=>outfit.id===support.outfitId);
    if(!outfit)throw Error('Unregistered guide outfit');
    const character={...selected,hero:outfit.hero,reactions:outfit.reactions,views:outfit.views,viewLabels:outfit.viewLabels,outfitId:outfit.id,title:`AI Sister・${outfit.label}服裝`};
    return {character,guides:PAGE_GUIDES[pageId]??{},loadContent:async()=>{
      const content=await loadPageContent(support.contentId);
      return {...content,characterName:character.name,entryLine:`我是 ${character.name}。${content.entryLine}`};
    }};
  },
};
