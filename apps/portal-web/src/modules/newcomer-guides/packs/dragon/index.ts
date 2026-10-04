import manifest from '../../../../../../../contracts/guide-packs/dragon-v1-20261004.json';
import characters from './characters.json';
import {DRAGON_GUIDES} from './guide-data';
import {DRAGON_PAGE_SUPPORT} from '../../page-support';
import {DRAGON_RELEASE_PIN} from '../../release-pin';
import type {GuideCharacter,GuidePack} from '../../contracts';
import type {SpiritPack} from '../../engine/core';

const assets=new Map(manifest.assets.map(asset=>[asset.logicalId,asset]));
function assetPath(logicalId:string):string {
  const asset=assets.get(logicalId);if(!asset)throw Error('Unregistered guide asset');
  return `/public/guide-packs/${manifest.pack}/${manifest.version}/${asset.sha256}.webp`;
}
const catalog:Readonly<Record<string,GuideCharacter>>=Object.fromEntries(Object.entries(characters).map(([id,character])=>[id,{...character,portrait:assetPath(character.portrait),hero:assetPath(character.hero),frames:character.frames.map(assetPath),views:character.views.map(assetPath)}]));
const loaders:Record<string,()=>Promise<SpiritPack>>={
  'home':()=>import('./content/home.json').then(module=>module.default),
  'guilds':()=>import('./content/guilds.json').then(module=>module.default),
  'skills':()=>import('./content/skills.json').then(module=>module.default),
  'messages':()=>import('./content/messages.json').then(module=>module.default),
  'events':()=>import('./content/events.json').then(module=>module.default),
  'tasks':()=>import('./content/tasks.json').then(module=>module.default),
  'members':()=>import('./content/members.json').then(module=>module.default),
  'friends':()=>import('./content/friends.json').then(module=>module.default),
  'highlights':()=>import('./content/highlights.json').then(module=>module.default),
  'positioning':()=>import('./content/positioning.json').then(module=>module.default),
  'squads':()=>import('./content/squads.json').then(module=>module.default),
  'cocreation':()=>import('./content/cocreation.json').then(module=>module.default),
  'social':()=>import('./content/social.json').then(module=>module.default),
  'services':()=>import('./content/services.json').then(module=>module.default),
  'promotion':()=>import('./content/promotion.json').then(module=>module.default),
  'workbench':()=>import('./content/workbench.json').then(module=>module.default),
  'opensource':()=>import('./content/opensource.json').then(module=>module.default),
  'showcase':()=>import('./content/showcase.json').then(module=>module.default),
  'engagement':()=>import('./content/engagement.json').then(module=>module.default),
  'supplier':()=>import('./content/supplier.json').then(module=>module.default),
  'retail':()=>import('./content/retail.json').then(module=>module.default),
  'marketing':()=>import('./content/marketing.json').then(module=>module.default),
  'guild-workspace':()=>import('./content/guild-workspace.json').then(module=>module.default),
  'community':()=>import('./content/community.json').then(module=>module.default),
  'account':()=>import('./content/account.json').then(module=>module.default),
  'todos':()=>import('./content/todos.json').then(module=>module.default),
};
export const DRAGON_PACK:GuidePack={format:'freedom.newcomer-guide/v1',id:'dragon',version:DRAGON_RELEASE_PIN.version,engineContractVersion:1,locale:'zh-Hant',label:'龍娘',pages:DRAGON_PAGE_SUPPORT,gallery:Object.values(catalog),
  async loadPage(pageId){
    if(!Object.hasOwn(DRAGON_PAGE_SUPPORT,pageId) || DRAGON_PAGE_SUPPORT[pageId as keyof typeof DRAGON_PAGE_SUPPORT].status!=='supported' || !Object.hasOwn(catalog,pageId) || !Object.hasOwn(loaders,pageId))throw Error('Unsupported guide page');
    return {character:catalog[pageId],guides:DRAGON_GUIDES[pageId]??{},loadContent:async()=>{
      const content=await loaders[pageId]();
      if(content.id!==pageId || content.characterName!==catalog[pageId].name || content.topics.some(topic=>!topic.id.startsWith(`${pageId}:`)))throw Error('Guide content mismatch');
      return content;
    }};
  }
};
