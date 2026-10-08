import {z} from 'zod';

export const BlockStateSchema=z.object({
  user_id:z.uuid(),
  blocked_by_me:z.boolean(),
  aggregate_version:z.number().int().positive().nullable(),
}).strict();
export type BlockState=z.infer<typeof BlockStateSchema>;

export const BlockListSchema=z.object({
  items:z.array(z.object({
    user_id:z.uuid(),
    nickname:z.string().nullable(),
    blocked_at:z.iso.datetime(),
    aggregate_version:z.number().int().positive(),
  }).strict()),
  next_offset:z.number().int().min(0).nullable(),
}).strict();
export type BlockList=z.infer<typeof BlockListSchema>;
