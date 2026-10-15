import { z } from 'zod';
export const id = z.uuid();
export const text = (max=2000) => z.string().trim().min(1).max(max);
export const opaqueRef = z.string().regex(/^[a-z][a-z0-9_-]{1,30}:[A-Za-z0-9][A-Za-z0-9._~-]{0,199}$/,'請使用不含私人內容或網址的引用，例如 artifact:template-v1。');
export const money = z.number().int().min(1).max(100000000000);
export const currency = z.enum(['TWD','USD']);
// ISO syntax alone permits year zero and offsets outside PostgreSQL's range.
// Preserve the original text and fractional precision; only bound those fields.
export const isoTime = z.iso.datetime({offset:true})
  .refine(value=>{
    if(value.startsWith('0000'))return false;
    if(value.endsWith('Z'))return true;
    // Zod checks the digits; read the hour in either ±HH:MM or ±HHMM.
    const hourStart=value.length-(value.at(-3)===':'?5:4);
    return (value.charCodeAt(hourStart)-48)*10+(value.charCodeAt(hourStart+1)-48)<16;
  });
