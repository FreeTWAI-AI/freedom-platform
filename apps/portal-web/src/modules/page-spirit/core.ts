// Each session receives exactly one trusted page pack. No network or business actions.
export type SpiritState = 'idle' | 'wave' | 'think' | 'cheer' | 'calm' | 'sleep'
export type SpiritReplyKind = 'scope' | 'no-action' | 'greeting' | 'thanks' | 'rest' | 'identity' | 'help' | 'topic' | 'follow-up'
export interface SpiritTopic { id: string; label: string; keywords: string[]; answer: string; nextStep?: string }
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
  ask(input: unknown, topicId?: string, contextTopicId?: string | null): SpiritReply
  readonly history: SpiritMessage[]
  clear(): void
}
export const STATES: readonly SpiritState[] = Object.freeze(['idle','wave','think','cheer','calm','sleep'])
export function normalize(text: unknown): string {
  return String(text ?? '').normalize('NFKC').toLowerCase().replace(/[\s，。！？、：；,.!?;:「」『』（）()]/gu,'')
}

// Remove only reviewed question wrappers. The complete remaining phrase still
// has to equal one alias from this page; no substring or cross-page search.
function questionForms(text: string, page: SpiritPack): string[] {
  const prefixes = ['請問','我想了解','我想知道','我想問','想了解','想知道','可以說明','能說明','請說明','麻煩說明',
    '可以告訴我','能告訴我','告訴我','想請教','請教','幫我了解','這一頁的','這頁的','本頁的','關於','有關', `${normalize(page.title)}的`]
  const suffixes = ['要怎麼使用','要怎麼操作','要怎麼開始','要怎麼看','要怎麼用','怎麼使用','怎麼操作','怎麼開始',
    '怎麼找到','怎麼找','在哪裡','在哪','哪裡','怎麼開','怎麼看','怎麼用','是什麼','的意思','的說明','說明一下','嗎','呢','呀','啊','喔','囉','啦','唷','一下']
  const forms = new Set([text]), queue = [{text, depth: 0}]
  while (queue.length && forms.size < 64) {
    const item = queue.shift()!
    if (item.depth >= 4) continue
    const add = (candidate: string) => {
      if (forms.size >= 64 || candidate.length < 2 || forms.has(candidate)) return
      forms.add(candidate); queue.push({text: candidate, depth: item.depth + 1})
    }
    for (const prefix of prefixes) if (item.text.startsWith(prefix)) add(item.text.slice(prefix.length))
    for (const suffix of suffixes) if (item.text.endsWith(suffix)) add(item.text.slice(0, -suffix.length))
  }
  return [...forms]
}

const NEXT_QUESTION = /^(接下來|接下來呢|下一步|下一步呢|接著呢|我要怎麼做|然後呢)$/u
const REPEAT_QUESTION = /^(再說一次|再說一次吧|可以再說一次嗎|再說明一次|剛剛那題)$/u
const CLARIFY_QUESTION = /^(我還是不懂|還是看不懂|可以簡單說嗎|換個說法)$/u
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
  const forms = new Set(questionForms(text, page))
  const intent = (pattern: RegExp) => [...forms].some(form => pattern.test(form))
  if (intent(/^(你好|嗨|嗨嗨|哈囉|早安|午安|晚安|hello|hi|在嗎)$/u)) return reply(`嗨，我是${name}，今天在「${page.title}」值班。想問這一頁的哪個地方？`,'wave','greeting')
  if (intent(/^(謝謝|謝謝你|謝謝妳|謝謝你幫忙|謝謝妳幫忙|感謝|感謝你|感謝妳|謝啦|thankyou|thanks)$/u)) return reply('不客氣，這一頁還有想問的，就叫我。','cheer','thanks')
  if (intent(/^(累了|我累了|我好累|我有點累|休息|想休息|先休息|我想休息)$/u)) return reply('先歇一下也好。這一頁等你回來再看。','sleep','rest')
  if (intent(/^(你是誰|妳是誰|你叫什麼名字|妳叫什麼名字|介紹自己|小龍娘)$/u) || text===normalize(name)) return reply(`我是${name}，只負責「${page.title}」。我會說明這一頁的內容，切頁後會重新開始。`,'wave','identity')
  if (intent(/^(這頁能做什麼|這一頁能做什麼|本頁說明|怎麼開始|我不懂|我不會用|不知道怎麼用|幫助)$/u)
    || intent(NEXT_QUESTION) || intent(REPEAT_QUESTION) || intent(CLARIFY_QUESTION)) return reply(page.entryLine,'think','help')
  const topics = page.topics.filter(item => [item.label,...item.keywords].some(alias => forms.has(normalize(alias))))
  return topics.length === 1 ? reply(topics[0].answer,'think','topic',topics[0].id) : unknown()
}
export function createPageSession(page: SpiritPack): SpiritSession {
  let history: SpiritMessage[]=[]
  let currentTopic: string | null = null
  return {
    pageId:page.id,
    ask(input,topicId,contextTopicId) {
      const text = normalize(input)
      const context = contextTopicId === undefined ? currentTopic : contextTopicId
      const topic = page.topics.find(item => item.id === context)
      const forms = questionForms(text, page)
      const next = forms.some(form => NEXT_QUESTION.test(form) || CLARIFY_QUESTION.test(form))
      const followUp = !topicId && (next || forms.some(form => REPEAT_QUESTION.test(form)))
      let result = getReply(page,input,topicId)
      if (followUp && result.kind === 'help' && topic) result = {pageId:page.id, text: next ? topic.nextStep || topic.answer : topic.answer,
        state:'think', kind:'follow-up', topicId:topic.id, userText:topic.label}
      else if (followUp && result.kind === 'help' && contextTopicId && !topic) result = {pageId:page.id,text:page.unknownLine,state:'calm',kind:'scope',topicId:null,userText:'未收錄的本頁問題'}
      if (result.topicId) currentTopic = result.topicId
      else if (result.kind !== 'thanks') currentTopic = null
      history.push({role:'user',text:result.userText},{role:'assistant',text:result.text})
      history=history.slice(-12)
      return result
    },
    get history() {return history.map(message=>({...message}))},
    clear() {history=[];currentTopic=null},
  }
}
