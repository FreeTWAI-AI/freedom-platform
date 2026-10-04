import {useEffect, useState} from 'react';
import type {PortalClient} from '../api';
import {MemberAvatar} from './MemberAvatar';
import {PromotionShare} from './PromotionShare';
import './PromotionBoards.css';

type Period = 'week' | 'month' | 'all';
type Kind = 'member_card' | 'platform' | 'skill_book' | 'social_post' | 'member_service' | 'event';
type Item = {rank: number; user_id: string; display_name: string; avatar_url: string | null; points: number};
type Board = {kind: Kind; items: Item[]; me: {rank: number; points: number} | null};
type Boards = {period: Period; boards: Board[]};
type Mine = {period: Period; items: {kind: Kind; target: string; code: string; path: string; title: string; period_points: number; available: boolean}[]};

const PERIODS: {id: Period; label: string}[] = [{id: 'week', label: '本週'}, {id: 'month', label: '本月'}, {id: 'all', label: '累計'}];
const COPY: Record<Kind, {title: string; how: string; label: string}> = {
  member_card: {title: '名片點擊排行榜', label: '名片', how: '在我的名片分享名片連結，每次點擊 +1。'},
  platform: {title: '平台推廣排行榜', label: '平台', how: '分享自由工坊連結，每次點擊 +1。'},
  skill_book: {title: '技能推廣排行榜', label: '技能', how: '從技能書架分享技能書，每次點擊 +1。'},
  social_post: {title: '社群推廣排行榜', label: '社群', how: '在社群分享專區分享貼文，每次點擊 +1。'},
  member_service: {title: '業務推廣排行榜', label: '業務', how: '在社員服務分享區分享社員的服務，每次點擊 +1。'},
  event: {title: '活動推廣排行榜', label: '活動', how: '分享社群活動，每次點擊 +1。'},
};
const WORKSHOP_TEXT = '自由工坊：加入公會、領取 Repo 技能書，和夥伴一起供貨、開店與做開源作品。';

export function PromotionBoards({client}: {client: PortalClient}) {
  const [period, setPeriod] = useState<Period>('week');
  const [boards, setBoards] = useState<Board[] | null>(null);
  const [mine, setMine] = useState<Mine['items']>([]);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    let live = true;
    setError('');
    void Promise.all([
      client.get<Boards>(`/promotion/leaderboards?period=${period}`),
      client.get<Mine>(`/promotion/links/mine?period=${period}`),
    ]).then(([board, links]) => { if (live) { setBoards(board.boards); setMine(links.items); } })
      .catch((cause: unknown) => { if (live) setError(cause instanceof Error ? cause.message : '排行榜暫時無法載入。'); });
    return () => { live = false; };
  }, [client, period]);
  const shown = expanded ? mine : mine.slice(0, 10);
  async function copy(path: string) {
    const url = `${window.location.origin}${path}`;
    try { await navigator.clipboard.writeText(url); setNotice('已複製連結'); }
    catch { setNotice(url); }
  }
  return <section className="promotion-page stack" aria-label="推廣排行榜">
    <header className="promotion-head">
      <div className="promotion-periods" data-guide-anchor="promotion:period" role="group" aria-label="統計期間">
        {PERIODS.map(item => <button key={item.id} type="button" className="btn btn-ghost promotion-period" aria-pressed={period === item.id} onClick={() => { setExpanded(false); setPeriod(item.id); }}>{item.label}</button>)}
      </div>
      <PromotionShare client={client} kind="platform" target="workshop" title="自由工坊" text={WORKSHOP_TEXT} label="分享自由工坊"/>
    </header>
    {notice && <p className="banner banner-info" role="status">{notice}</p>}
    {error && <div className="banner banner-error" role="alert"><p>{error}</p></div>}
    {!boards && !error && <p role="status">正在載入排行榜…</p>}
    {boards && <div className="promotion-boards">
      {boards.map(board => <article className="card promotion-board" key={board.kind} aria-label={COPY[board.kind].title}>
        <h2>{COPY[board.kind].title}</h2>
        <p className="promotion-howto">{COPY[board.kind].how}</p>
        {board.items.length === 0 ? <p className="promotion-empty">還沒有人得分，分享第一個連結吧。</p> : <ol>
          {board.items.map(item => <li key={item.user_id}><span className="promotion-person"><MemberAvatar nickname={item.display_name} avatarUrl={item.avatar_url} className="promotion-avatar"/> <span>{item.display_name}</span></span><strong>{item.points}</strong></li>)}
        </ol>}
        <p className="promotion-me">{board.me ? `我的名次：第 ${board.me.rank} 名・${board.me.points} 分` : '你在這個排行榜還沒有分數。'}</p>
      </article>)}
    </div>}
    <section className="card promotion-mine" aria-label="我的推廣連結">
      <h2>我的推廣連結</h2>
      {shown.length === 0 ? <p className="promotion-empty">還沒有分享連結。</p> : <ul>
        {shown.map(item => <li key={item.code} className={item.available ? undefined : 'is-unavailable'}><span className="promotion-kind">{COPY[item.kind].label}</span><span className="promotion-link-title">{item.available ? item.title : '已無法開啟'}</span>{item.available && <button type="button" className="btn btn-ghost" onClick={() => void copy(item.path)}>複製</button>}<strong>{item.period_points}</strong></li>)}
      </ul>}
      {mine.length > 10 && <button type="button" className="btn btn-ghost" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? '收合' : '顯示全部'}</button>}
    </section>
    <details className="promotion-rules">
      <summary>計分規則</summary>
      <p>同一位訪客每天點同一個連結只算 1 分；本人點擊、連結預覽機器人不計分；分數只顯示在排行榜，不計入會員經驗、獎勵或驗收。</p>
    </details>
  </section>;
}
