import React from 'react';
import {z} from 'zod';
import {useGuildRead, type GuildBlockProps} from '../../packages/guild-presentation/block';
import {GuildBlockState} from '../../apps/portal-web/src/guild-blocks/GuildBlockState';

const contentSchema = z.object({items: z.array(z.object({kind: z.enum(['showcase','skill_submission','event','social_post']), id: z.string().uuid(), title: z.string(), status: z.string(), visibility: z.string(), actions: z.array(z.string())}))});
const parse = (value: unknown) => contentSchema.parse(value).items.filter(item => item.kind === 'showcase' || item.kind === 'skill_submission');
const status: Record<string, string> = {draft: '私人草稿', published: '已發布', withdrawn: '已撤下', revoked: '已撤銷', ready_for_review: '準備發布', awaiting_upload: '等待上傳'};
export const title = '我的作品與開源分享';

export default function WorksBlock({client, viewer, navigate}: GuildBlockProps) {
  const {state, retry} = useGuildRead(client, viewer, '/me/content', parse);
  return <div className="stack">
    <p>先保存作品介紹與來源，再由你決定公開。一般作品與技能書投稿保留各自的發布流程。</p>
    <GuildBlockState state={state} retry={retry} noun="作品與技能投稿"/>
    {state.kind === 'ready' && <>
      {state.data.length ? <ul className="stack">{state.data.slice(0, 3).map(item => <li key={`${item.kind}:${item.id}`}>
        <strong>{item.title || '未命名內容'}</strong><p className="field-hint">{item.kind === 'showcase' ? '作品' : '技能投稿'} · {status[item.status] ?? item.status} · {item.visibility === 'public' ? '已選擇公開' : '依原內容可見範圍'}</p>
      </li>)}</ul> : <p>還沒有作品或技能投稿，可以先保存一份私人草稿。</p>}
      <div className="actions"><button type="button" className="btn btn-ghost btn-small" onClick={() => navigate('#my-content')}>查看我的內容</button>
        {viewer === 'member' && <button type="button" className="btn btn-ghost btn-small" onClick={() => navigate('#opensource')}>準備技能投稿</button>}
      </div>
      {viewer === 'read_only' && <p className="field-hint">此區塊只顯示目前可讀內容，不會替你發布或更改授權。</p>}
    </>}
  </div>;
}
