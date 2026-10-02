// Each session receives exactly one trusted page pack. No network or business actions.
export type SpiritState = 'idle' | 'wave' | 'think' | 'cheer' | 'calm' | 'sleep'
export type SpiritReplyKind = 'scope' | 'no-action' | 'greeting' | 'thanks' | 'rest' | 'identity' | 'help' | 'topic'
export interface SpiritTopic { id: string; label: string; keywords: string[]; answer: string }
export interface SpiritPack {
  id: string
  title: string
  characterName: string
  entryLine: string
  unknownLine: string
  topics: SpiritTopic[]
}
export interface SpiritReply {
  pageId: string; text: string; state: SpiritState; kind: SpiritReplyKind; topicId: string | null; userText: string
}
export interface SpiritMessage { role: 'user' | 'assistant'; text: string }
export interface SpiritSession {
  readonly pageId: string
  ask(input: unknown, topicId?: string): SpiritReply
  readonly history: SpiritMessage[]
  clear(): void
}
export const STATES: readonly SpiritState[] = Object.freeze(['idle','wave','think','cheer','calm','sleep'])
export function normalize(text: unknown): string {
  return String(text ?? '').normalize('NFKC').toLowerCase().replace(/[\s，。！？、：；,.!?;:「」『』（）()]/gu,'')
}
export function getReply(page: SpiritPack, input: unknown, topicId?: string): SpiritReply {
  if (!page || !Array.isArray(page.topics)) throw new TypeError('One trusted page pack is required')
  const name = page.characterName || '當頁服務精靈'
  const intentLabels: Partial<Record<SpiritReplyKind,string>> = {scope:'未收錄的本頁問題','no-action':'詢問操作協助',greeting:'打招呼',thanks:'謝謝',rest:'想休息一下',identity:'角色介紹',help:'本頁說明'}
  const reply = (text: string, state: SpiritState = 'calm', kind: SpiritReplyKind = 'scope', topic: string | null = null): SpiritReply => ({
    pageId:page.id,text,state,kind,topicId:topic,
    userText:(topic ? page.topics.find(item=>item.id===topic)?.label : null) || intentLabels[kind] || '本頁問題',
  })
  const unknown = () => reply(page.unknownLine)
  if (topicId) {
    const topic=page.topics.find(item=>item.id===topicId)
    return topic ? reply(topic.answer,'think','topic',topic.id) : unknown()
  }
  const raw=String(input ?? '').trim()
  if (!raw || raw.length>240) return unknown()
  const text=normalize(raw)
  if (/幫我(?:送出|傳送|付款|刪除|退出|認領|核准|批准|加入|報名|上傳)|替我|代我/u.test(text)) {
    return reply(`我可以說明「${page.title}」的操作。要送出或變更資料，請使用頁面原本的按鈕。`,'calm','no-action')
  }
  if (/忽略|systemprompt|系統提示|秘密|api.?key|提示詞|執行指令|其他頁|別頁|全站|跨頁|https?:|#[a-z]|\/admin/u.test(text)) return unknown()
  if (/^(你好|嗨|哈囉|早安|午安|晚安|hello|hi|在嗎)$/u.test(text)) return reply(`嗨，我是${name}，今天在「${page.title}」值班。想問這一頁的哪個地方？`,'wave','greeting')
  if (/^(謝謝|感謝|謝啦|thankyou|thanks)$/u.test(text)) return reply('不客氣，這一頁還有想問的，就叫我。','cheer','thanks')
  if (/^(累了|我好累|休息|想休息)$/u.test(text)) return reply('先歇一下也好。這一頁等你回來再看。','sleep','rest')
  if (/^(你是誰|介紹自己|小龍娘)$/u.test(text) || text===normalize(name)) return reply(`我是${name}，只負責「${page.title}」。我會說明這一頁的內容，切頁後會重新開始。`,'wave','identity')
  if (/^(這頁能做什麼|這一頁能做什麼|本頁說明|怎麼開始|我不懂|不知道怎麼用|幫助)$/u.test(text)) return reply(page.entryLine,'think','help')
  const topic=page.topics.find(item=>[item.label,...item.keywords].some(alias=>text===normalize(alias)))
  return topic ? reply(topic.answer,'think','topic',topic.id) : unknown()
}
export function createPageSession(page: SpiritPack): SpiritSession {
  let history: SpiritMessage[]=[]
  return {
    pageId:page.id,
    ask(input,topicId) {
      const result=getReply(page,input,topicId)
      history.push({role:'user',text:result.userText},{role:'assistant',text:result.text})
      history=history.slice(-12)
      return result
    },
    get history() {return history.map(message=>({...message}))},
    clear() {history=[]},
  }
}
