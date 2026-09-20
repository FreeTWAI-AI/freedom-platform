import { z } from 'zod';
export const id = z.uuid();
export const text = (max=2000) => z.string().trim().min(1).max(max);
export const opaqueRef = z.string().regex(/^[a-z][a-z0-9_-]{1,30}:[A-Za-z0-9][A-Za-z0-9._~-]{0,199}$/,'請使用不含私人內容或網址的引用，例如 artifact:template-v1。');
export const money = z.number().int().min(1).max(100000000000);
export const currency = z.enum(['TWD','USD']);
export const isoTime = z.iso.datetime({offset:true});
