import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const manifest=JSON.parse(fs.readFileSync(path.join(root,'docs/design/page-spirit-art-manifest.json'),'utf8'))
const records=manifest.characters
if (!Array.isArray(records) || records.length!==26) throw new Error('Expected 26 character records')
const escape=text=>String(text).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]))
const version='/art/page-spirit/v2-20261002'
const labels=['正面','左前45°','左側90°','背面','右側90°','右前45°']
const cards=records.map(record=>`<article id="${escape(record.pageId)}"><h2>${escape(record.name)}</h2><p><a href="/#${escape(record.pageId)}">返回所屬頁面</a></p><div class="views">${labels.map((label,i)=>`<figure><img src="${version}/${record.pageId}/view-${i}.webp" alt="${escape(record.name)}${label}" width="384" height="576" loading="lazy"><figcaption>${label}</figcaption></figure>`).join('')}</div></article>`).join('')
const html=`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>自由工坊龍娘六視圖</title><link rel="stylesheet" href="/page-spirit-gallery.css"></head><body><header><h1>自由工坊龍娘六視圖</h1><p>每個會員主頁都有自己的龍娘。這裡保存角色的外觀參考；交談時的動作由另外六張逐格圖片播放。</p><nav aria-label="角色目錄">${records.map(record=>`<a href="#${record.pageId}">${escape(record.name)}</a>`).join('')}</nav></header><main>${cards}</main></body></html>`
fs.writeFileSync(path.join(root,'apps/portal-web/public/page-spirit-characters.html'),html)
console.log(JSON.stringify({characters:records.length,bytes:Buffer.byteLength(html)}))
