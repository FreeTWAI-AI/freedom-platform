import { useState } from 'react';
import './MemberAvatar.css';

const initials = new Intl.Segmenter('zh-TW', { granularity: 'grapheme' });

export type AvatarMetadata = { avatar_url: string | null; aggregate_version: number };

export function MemberAvatar({ nickname, avatarUrl, className = '' }: { nickname: string; avatarUrl?: string | null; className?: string }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  // Member images always come from the authenticated local route, never a
  // user-supplied external URL. A failed/removed photo falls back to an initial.
  const safeUrl = avatarUrl && /^\/api\/v1\/members\/[0-9a-f-]{36}\/avatar\?v=[1-9][0-9]*$/.test(avatarUrl) ? avatarUrl : null;
  return <div className={`member-avatar member-avatar-photo ${className}`}>
    {safeUrl && failedUrl !== safeUrl
      ? <img src={safeUrl} alt={`${nickname}的頭像`} width="256" height="256" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailedUrl(safeUrl)}/>
      : <span aria-hidden="true">{initials.segment(nickname.trim())[Symbol.iterator]().next().value?.segment || '?'}</span>}
  </div>;
}
