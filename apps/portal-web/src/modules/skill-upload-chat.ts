export const CHAT_JSON_MAX_BYTES = 800 * 1024;

export function chatSkillInstruction(repositoryUrl: string): string {
  const repo = repositoryUrl.trim().replace(/\/$/, '');
  const link = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ? repo : '';
  const source = link
    ? `請讀取這個公開儲存庫：${link}\n如果打不開連結，請等我貼上 README、SKILL.md 與 LICENSE 再寫。`
    : '請等我貼上 README、SKILL.md 與 LICENSE，再依那些檔案撰寫。';
  return `請只回覆一個 JSON 物件，不要加說明，也不要用 Markdown 程式碼區塊。
${source}
用繁體中文，只寫檔案裡確實有的內容：
- repository_url：${link || 'https://github.com/擁有者/儲存庫'}
- title：技能名稱
- description：真實介紹
- use_notes：適合誰、需要什麼、第一個使用步驟與限制
- relationship：預設 "curator"；只有我明確說自己是原作者、維護者或貢獻者，才改成 author、maintainer 或 contributor
- share_introductions：剛好 100 則彼此不同的分享短文，每則 8 到 200 字
- demo_url：不確定就 null
不確定的事實寫「尚未確認」。不要寫入任何金鑰或授權。`;
}

export function parseChatSkillJson(raw: string): { ok: true; value: Record<string, unknown>; text: string } | { ok: false; message: string } {
  let text = raw.replace(/^\uFEFF/, '').trim();
  const fenced = text.match(/^```(?:json)?[^\n]*\n([\s\S]*?)\n```$/i);
  if (fenced) text = fenced[1].trim();
  if (!text) return { ok: false, message: '請貼上聊天 AI 回覆的 JSON。' };
  if (new TextEncoder().encode(text).byteLength > CHAT_JSON_MAX_BYTES) return { ok: false, message: 'JSON 超過 800 KB 上限。請讓 AI 縮小內容，不要附上過大的示意圖。' };
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { return { ok: false, message: '這段不是 JSON。若聊天 AI 用 ```json 程式碼區塊包住，請整段貼上；前後不要再加說明。' }; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, message: '請貼上一個 JSON 物件（以 { 開頭），不要貼陣列或其他文字。' };
  return { ok: true, value: value as Record<string, unknown>, text };
}
