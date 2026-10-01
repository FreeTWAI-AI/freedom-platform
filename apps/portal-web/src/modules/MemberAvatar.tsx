import { useState } from 'react';
import './MemberAvatar.css';

const initials = new Intl.Segmenter('zh-TW', { granularity: 'grapheme' });

export type AvatarMetadata = { avatar_url: string | null; aggregate_version: number };

export function MemberAvatar({ nickname, avatarUrl, className = '' }: { nickname: string; avatarUrl?: string | null; className?: string }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  // Accept only the authenticated avatar route or an opt-in share capability.
  const safeUrl = avatarUrl && (/^\/api\/v1\/members\/[0-9a-f-]{36}\/avatar\?v=[1-9][0-9]*$/.test(avatarUrl)||/^\/api\/v1\/public\/member-cards\/[A-Za-z0-9_-]{43}\/avatar$/.test(avatarUrl)) ? avatarUrl : null;
  return <div className={`member-avatar member-avatar-photo ${className}`}>
    {safeUrl && failedUrl !== safeUrl
      ? <img src={safeUrl} alt={`${nickname}的頭像`} width="256" height="256" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailedUrl(safeUrl)}/>
      : <span aria-hidden="true">{initials.segment(nickname.trim())[Symbol.iterator]().next().value?.segment || '?'}</span>}
  </div>;
}
