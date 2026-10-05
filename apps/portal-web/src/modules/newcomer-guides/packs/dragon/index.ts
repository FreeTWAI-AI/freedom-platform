import manifest from '../../../../../../../contracts/guide-packs/dragon-v1-20261004.json';
import characters from './characters.json';
import {DRAGON_GUIDES} from './guide-data';
import {DRAGON_PAGE_SUPPORT} from '../../page-support';
import {DRAGON_RELEASE_PIN} from '../../release-pin';
import type {GuideCharacter,GuidePack} from '../../contracts';
import {loadPageContent} from '../page-content';

const assets=new Map(manifest.assets.map(asset=>[asset.logicalId,asset]));
function assetPath(logicalId:string):string {
  const asset=assets.get(logicalId);if(!asset)throw Error('Unregistered guide asset');
  return `/public/guide-packs/${manifest.pack}/${manifest.version}/${asset.sha256}.webp`;
}
const catalog:Readonly<Record<string,GuideCharacter>>=Object.fromEntries(Object.entries(characters).map(([id,character])=>[id,{...character,portrait:assetPath(character.portrait),hero:assetPath(character.hero),frames:character.frames.map(assetPath),views:character.views.map(assetPath)}]));
export const DRAGON_PACK:GuidePack={format:'freedom.newcomer-guide/v1',id:'dragon',version:DRAGON_RELEASE_PIN.version,engineContractVersion:1,locale:'zh-Hant',label:'龍娘',pages:DRAGON_PAGE_SUPPORT,gallery:Object.values(catalog),galleryInfo:{title:'角色六視圖',attribution:'原創角色圖來自 mars-tw 的',sourceLabel:'PR #106',sourceUrl:'https://github.com/FreeTWAI-AI/freedom-platform/pull/106'},
  async loadPage(pageId){
    if(!Object.hasOwn(DRAGON_PAGE_SUPPORT,pageId) || DRAGON_PAGE_SUPPORT[pageId as keyof typeof DRAGON_PAGE_SUPPORT].status!=='supported' || !Object.hasOwn(catalog,pageId))throw Error('Unsupported guide page');
    return {character:catalog[pageId],guides:DRAGON_GUIDES[pageId]??{},loadContent:async()=>{
      const content=await loadPageContent(pageId);
      if(content.id!==pageId || content.characterName!==catalog[pageId].name || content.topics.some(topic=>!topic.id.startsWith(`${pageId}:`)))throw Error('Guide content mismatch');
      return content;
    }};
  }
};
