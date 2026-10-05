// Reviewed page facts shared by guide packs; original copy by mars-tw, PR #106.
import type {SpiritPack} from '../engine/core';
const loaders:Record<string,()=>Promise<SpiritPack>>={
  'home':()=>import('./dragon/content/home.json').then(module=>module.default),
  'guilds':()=>import('./dragon/content/guilds.json').then(module=>module.default),
  'skills':()=>import('./dragon/content/skills.json').then(module=>module.default),
  'messages':()=>import('./dragon/content/messages.json').then(module=>module.default),
  'events':()=>import('./dragon/content/events.json').then(module=>module.default),
  'tasks':()=>import('./dragon/content/tasks.json').then(module=>module.default),
  'members':()=>import('./dragon/content/members.json').then(module=>module.default),
  'friends':()=>import('./dragon/content/friends.json').then(module=>module.default),
  'highlights':()=>import('./dragon/content/highlights.json').then(module=>module.default),
  'positioning':()=>import('./dragon/content/positioning.json').then(module=>module.default),
  'squads':()=>import('./dragon/content/squads.json').then(module=>module.default),
  'cocreation':()=>import('./dragon/content/cocreation.json').then(module=>module.default),
  'social':()=>import('./dragon/content/social.json').then(module=>module.default),
  'services':()=>import('./dragon/content/services.json').then(module=>module.default),
  'promotion':()=>import('./dragon/content/promotion.json').then(module=>module.default),
  'workbench':()=>import('./dragon/content/workbench.json').then(module=>module.default),
  'opensource':()=>import('./dragon/content/opensource.json').then(module=>module.default),
  'showcase':()=>import('./dragon/content/showcase.json').then(module=>module.default),
  'engagement':()=>import('./dragon/content/engagement.json').then(module=>module.default),
  'supplier':()=>import('./dragon/content/supplier.json').then(module=>module.default),
  'retail':()=>import('./dragon/content/retail.json').then(module=>module.default),
  'marketing':()=>import('./dragon/content/marketing.json').then(module=>module.default),
  'guild-workspace':()=>import('./dragon/content/guild-workspace.json').then(module=>module.default),
  'community':()=>import('./dragon/content/community.json').then(module=>module.default),
  'account':()=>import('./dragon/content/account.json').then(module=>module.default),
  'todos':()=>import('./dragon/content/todos.json').then(module=>module.default),
};
export async function loadPageContent(pageId:string):Promise<SpiritPack>{
  if(!Object.hasOwn(loaders,pageId))throw Error('Unsupported guide page');
  const content=await loaders[pageId]();
  if(content.id!==pageId || content.topics.some(topic=>!topic.id.startsWith(`${pageId}:`)))throw Error('Guide content mismatch');
  return content;
}
