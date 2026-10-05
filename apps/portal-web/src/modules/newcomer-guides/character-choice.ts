export const AI_SISTER_CHARACTER_KEY='freedom-ai-sister-character';
export const AI_SISTER_CHARACTER_IDS=['claude','chatgpt','gemini','grok','deepseek','qwen','mistral','venice','sakana','perplexity','glm','kimi','hunyuan','minimax','nemotron','cohere','mimo'] as const;
export function resolveAiSisterCharacter(value:unknown):string{
  return typeof value==='string' && AI_SISTER_CHARACTER_IDS.some(id=>id===value)?value:'claude';
}
export function readAiSisterCharacter(storage?:Pick<Storage,'getItem'>):string{
  try{return resolveAiSisterCharacter((storage??localStorage).getItem(AI_SISTER_CHARACTER_KEY))}catch{return 'claude'}
}
export function saveAiSisterCharacter(value:string):string{
  const selected=resolveAiSisterCharacter(value);
  try{localStorage.setItem(AI_SISTER_CHARACTER_KEY,selected)}catch{/* The current visit retains the choice. */}
  return selected;
}
