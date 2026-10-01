/** Immutable, first-party atlas. IDs stay stable after messages have been sent. */
export const CHAT_STICKERS=[
  {id:'workshop-v1-hello',label:'你好',keywords:'哈囉 招呼 hello',column:0,row:0},
  {id:'workshop-v1-thanks',label:'謝謝',keywords:'感謝 愛心 thank',column:1,row:0},
  {id:'workshop-v1-cheer',label:'加油',keywords:'鼓勵 太棒了 讚 cheer',column:0,row:1},
  {id:'workshop-v1-together',label:'一起共創',keywords:'合作 夥伴 拼圖 together',column:1,row:1},
] as const;
export const CHAT_STICKER_ATLAS='/art/chat/workshop-v1.png';
export type ChatStickerId=typeof CHAT_STICKERS[number]['id'];
export type ChatSticker={id:ChatStickerId;label:string};
export function findChatSticker(id:string|null|undefined){return CHAT_STICKERS.find(sticker=>sticker.id===id);}
