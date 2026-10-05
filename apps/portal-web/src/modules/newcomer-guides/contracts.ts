import type {SpiritPack} from './engine/core';
import type {GuideDefinition} from './engine/guides';
export type GuideReactions=Readonly<Partial<Record<'wave'|'think'|'cheer',string>>>;
export interface GuideOutfit {id:string;label:string;hero:string;reactions:GuideReactions;views:readonly string[];viewLabels:readonly string[]}
export interface GuideCharacter {
  pageId:string;name:string;title:string;accent:string;intro:string;backdropColor:string|null;
  portrait:string;hero:string;frames:readonly string[];views:readonly string[];viewLabels?:readonly string[];
  reactions?:GuideReactions;outfits?:readonly GuideOutfit[];outfitId?:string;
}
export interface GuideGalleryInfo {title:string;attribution:string;sourceLabel:string;sourceUrl:string}
export type PageGuideSupport =
  | {status:'supported';characterId:string;contentId:string;guideIds:readonly string[];anchorContractVersion:1;outfitId?:string}
  | {status:'disabled';reason:string};
export interface GuidePage {
  character:GuideCharacter;loadContent:()=>Promise<SpiritPack>;guides:Readonly<Record<string,GuideDefinition>>;
}
export interface GuidePack {
  format:'freedom.newcomer-guide/v1';id:string;version:string;engineContractVersion:1;locale:'zh-Hant';
  label:string;pages:Readonly<Record<string,PageGuideSupport>>;
  loadPage:(pageId:string,characterId?:string)=>Promise<GuidePage>;gallery:readonly GuideCharacter[];galleryInfo:GuideGalleryInfo;
  characterChoices?:readonly {id:string;label:string}[];
}
