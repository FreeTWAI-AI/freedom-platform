import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ModulePanelProps } from './shared';
import type { TabId } from '../types';
import { WorkshopIcon } from '../WorkshopIcon';
import { loadLabels, type MemberCardData } from './Membership';
import { MemberAvatar } from './MemberAvatar';
import { PromotionShare } from './PromotionShare';
import { logConsoleEvent } from '../game-console-core';
import { consoleChannel } from '../game-console-routing';
import './HomeDesign.css';
import {MemberRecommendations} from './MemberRecommendations';
import {SkillBookIntro, type IntroBook} from './SkillBookIntro';
import {openMemberChat} from './chat-entry';

const shortcuts: { id: TabId; title: string }[] = [
  { id: 'events', title: '社群活動' },
  { id: 'tasks', title: '社群任務' },
  { id: 'guilds', title: '我的公會' },
  { id: 'skills', title: '技能書架' },
];
const entries: { id: TabId; title: string; description: string; cover: string }[] = [
  { id: 'supplier', title: '我有東西要賣', description: '讓 AI 整理商品、建立內部商店', cover: 'market-network' },
  { id: 'retail', title: '我可以賣東西', description: '挑商品、讓 AI 製作公開商店', cover: 'workshop-hub' },
  { id: 'opensource', title: '開源投稿', description: '貼上網址與介紹，預覽後分享工具', cover: 'cooperation-forge' },
  { id: 'marketing', title: '行銷工作室', description: '撰寫介紹與記錄分享', cover: 'cooperation-forge' },
];

type HomeOnboarding = { entry_mode?: string; assessment_completed?: boolean };

export function MemberHome({ client, session, onNavigate }: ModulePanelProps) {
  const [member, setMember] = useState<MemberCardData | null>(null);
  const [labels, setLabels] = useState<Record<string, string> | null>(null);
  const [onboarding, setOnboarding] = useState<HomeOnboarding | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [guideBook, setGuideBook] = useState<IntroBook | null>(null);
  const [taskAction, setTaskAction] = useState<'tasks' | 'showcase' | null>(null);
  // Only the newest request of a mounted page may change the card; late or superseded replies are dropped.
  const request = useRef(0);
  const summary = useRef<HTMLElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);

  const load = useCallback((withLabels: boolean) => {
    const current = ++request.current;
    setLoading(true);
    void client.get<MemberCardData>(`/members/${session.user.user_id}`).then(data => {
      if (current !== request.current) return;
      const retrying = alertRef.current?.contains(document.activeElement);
      setMember(data); setLoadError(null); setLoading(false);
      if (retrying) requestAnimationFrame(() => summary.current?.focus());
    }).catch((error: unknown) => {
      if (current !== request.current) return;
      setLoadError(`名片暫時無法載入。${error instanceof Error ? error.message : ''}`); setLoading(false);
    });
    // Labels only decorate featured skills; without them the saved names or ids still show.
    if (withLabels) void loadLabels(client).then(data => { if (current === request.current) setLabels(data); }).catch(() => {});
    void client.get<HomeOnboarding>('/me/onboarding').then(data => {
      if (current === request.current) setOnboarding(data);
    }).catch(() => { if (current === request.current) setOnboarding(null); });
  }, [client, session.user.user_id]);

  useEffect(() => {
    setMember(null); setLabels(null); setOnboarding(null); setLoadError(null);
    load(true);
    return () => { request.current++; };
  }, [load]);

  // One request at a time and only on an explicit click; the button keeps focus while it waits.
  const retry = () => { if (!loading) load(labels === null); };

  const showAssessment = onboarding?.entry_mode === 'quick' && onboarding.assessment_completed !== true;
  const nickname = member?.nickname ?? session.user.display_name;
  const featured = (member?.featured_capabilities ?? member?.capabilities.slice(0, 3) ?? []).slice(0, 3);
  const skillLabel = (id: string) => id.startsWith('custom:') ? id.slice(7) : labels?.[id] ?? id;
  const primaryGuild = member?.primary_guild ?? null;
  const internPrimary = Boolean(primaryGuild && member?.member_tiers?.some(tier => tier.guild_key === primaryGuild.guild_key && tier.member_tier === 'intern'));
  useEffect(() => {
    const key = primaryGuild?.guild_key;
    if (!key) { setGuideBook(null); setTaskAction(null); return; }
    let active = true;
    setGuideBook(null); setTaskAction(null);
    // These reads only refine the buttons. A failure leaves the sentence and the shelf button in place.
    void Promise.allSettled([
      client.get<{ items: { guild_key: string; skill_books: IntroBook[] }[] }>('/guilds/directory'),
      client.get<{ items: { book_id?: string; id?: string }[] }>('/me/skill-books'),
      client.get<{ items: unknown[] }>('/task-board/preview'),
    ]).then(results => {
      if (!active) return;
      const [directory, grants, tasks] = results;
      const directoryItems = directory.status === 'fulfilled' && Array.isArray(directory.value.items) ? directory.value.items : null;
      const grantItems = grants.status === 'fulfilled' && Array.isArray(grants.value.items) ? grants.value.items : null;
      if (directoryItems && grantItems) {
        const guild = directoryItems.find(item => item.guild_key === key);
        const unlocked = new Set(grantItems.flatMap(item => {
          const id = item.book_id ?? item.id;
          return id ? [id] : [];
        }));
        setGuideBook(guild?.skill_books?.find(item => {
          const id = item.book_id ?? item.id;
          return Boolean(id && unlocked.has(id));
        }) ?? null);
      } else setGuideBook(null);
      const taskItems = tasks.status === 'fulfilled' && Array.isArray(tasks.value.items) ? tasks.value.items : null;
      setTaskAction(taskItems ? (taskItems.length > 0 ? 'tasks' : 'showcase') : null);
    });
    return () => { active = false; };
  }, [client, primaryGuild?.guild_key]);

  const nextStep = useMemo<{ message: string; label: string; action: 'guilds' | 'skills' } | null>(() => {
    if (!member) return null;
    if (member.primary_guild) return { action: 'skills', label: '前往技能書架',
      message: '到技能書架選一本技能書閱讀，開始練習。' };
    // The member card separates secondary guilds from other joined guilds.
    if (member.secondary_guilds.length > 0 || (member.joined_guilds?.length ?? 0) > 0)
      return { action: 'guilds', label: '設定主要公會',
        message: '從已加入的公會選擇主要公會。' };
    return { action: 'guilds', label: '探索職業公會',
      message: '加入感興趣的公會，再選擇主要公會。' };
  }, [member]);

  useEffect(() => {
    if (!nextStep) return;
    // Each confirmed load gets a fresh event, including a return to an earlier guild state.
    logConsoleEvent({channel:consoleChannel('guide_next_step'), kind:'guide', source:'下一步',
      action: nextStep.action, message: nextStep.message});
  }, [nextStep]);

  return <div className="member-home freedom-home">
    <div className="home-layout">
    <div className="home-main">
    {loadError && <div ref={alertRef} role="alert" className="banner banner-error home-load-error">
      <p>{loadError}下方常用入口仍可使用。</p>
      <button type="button" className="btn btn-ghost" aria-disabled={loading} onClick={retry}>{loading ? '正在重新載入名片…' : '重新載入名片'}</button>
    </div>}
    {nextStep && <section className="home-next-step" aria-label="公會與技能書建議">
      <div className="home-next-copy">
      <p className="home-next-eyebrow">下一步</p>
      <p id="home-next-step-description">{nextStep.message}</p>
      {internPrimary && <p className="field-hint guild-intern-notice" role="status">你是這個公會的實習成員：可以閱讀公會內容、在公會聊天室聊天。想發布或編輯，可以在聊天室跟會長打聲招呼，會長能把你設為正式成員。</p>}
      {primaryGuild && taskAction === 'tasks' && <p id="home-next-task-hint">社群任務板有開放中的任務，可自行挑選一件參與。</p>}
      {primaryGuild ? <div className="home-next-actions">
        {guideBook
          ? <SkillBookIntro book={guideBook} label="閱讀第一本技能書" describedBy="home-next-step-description"/>
          : <button type="button" className="btn btn-ghost" aria-describedby="home-next-step-description" onClick={() => onNavigate?.('skills')}>前往技能書架</button>}
        <button type="button" className="btn btn-ghost" aria-describedby="home-next-step-description" onClick={() => openMemberChat('guild', primaryGuild.guild_key)}>進入{primaryGuild.name}聊天室</button>
        {taskAction && <button type="button" className="btn btn-ghost" aria-describedby={taskAction === 'tasks' ? 'home-next-step-description home-next-task-hint' : 'home-next-step-description'} onClick={() => onNavigate?.(taskAction)}>{taskAction === 'tasks' ? '查看社群任務' : '分享作品與需求'}</button>}
      </div> : <div className="home-next-actions"><button type="button" className="btn btn-ghost" aria-describedby="home-next-step-description" onClick={() => onNavigate?.(nextStep.action)}>{nextStep.label}</button></div>}
      </div>
      <img className="home-next-art" src="/art/rpg/skill-codex.webp" alt="" width="124" height="108"/>
    </section>}

    <nav className="home-shortcuts" aria-label="常用入口">
      {shortcuts.map(entry => <button key={entry.id} type="button" className="home-shortcut" onClick={() => onNavigate?.(entry.id)}>
        <span className="home-shortcut-icon" aria-hidden="true"><WorkshopIcon name={entry.id}/></span><span>{entry.title}</span>
      </button>)}
    </nav>

    <section className="home-module-section" aria-labelledby="home-module-title">
      <header className="home-section-heading"><h2 id="home-module-title">商品、作品與推廣</h2></header>
      <div className="home-module-grid">
        {entries.map(entry => <article key={entry.id} className={`home-module-card home-module-${entry.id}`}>
          <div className="home-module-cover"><img src={`/art/rpg/${entry.cover}.webp`} alt="" width="768" height="512" loading="lazy"/></div>
          <div className="home-module-body">
            <h3 className="home-module-name">{entry.title}</h3>
            <p className="home-module-description">{entry.description}</p>
            <button type="button" className="btn home-module-button" aria-label={`進入${entry.title}`} onClick={() => onNavigate?.(entry.id)}>進入<span aria-hidden="true">↗</span></button>
          </div>
        </article>)}
      </div>
    </section>
    </div>
    <aside className="home-rail">
    <section ref={summary} tabIndex={-1} className="member-card home-member-summary guild-base-hero" aria-label="我的會員摘要" aria-busy={loading}>
      <div className="home-member-identity">
        <MemberAvatar nickname={nickname} avatarUrl={member?.avatar_url} className="home-member-initial"/>
        <div>
          <p className="home-member-name">{nickname}{member?.positioning_title && <span className="positioning-title">{member.positioning_title}</span>}</p>
          {member ? <p className="home-member-guild">{member.primary_guild ? `主要公會 · ${member.primary_guild.name}` : '尚未設定主要公會'}</p>
            : loading && <p className="home-member-guild" role="status">正在載入名片…</p>}
          {showAssessment && <p className="home-assessment-hint">完成定位後，名片會顯示擅長能力，也更容易遇到合適的夥伴。</p>}
        </div>
      </div>
      {featured.length > 0 && <div className="member-featured home-member-skills" aria-label="擅長的能力">
        {featured.map(id => <span className="pill" key={id}>{skillLabel(id)}</span>)}
      </div>}
      <div className="home-member-actions">
        <button type="button" className="btn btn-ghost" onClick={() => onNavigate?.('account')}>編輯我的名片</button>
        {showAssessment && <button type="button" className="btn btn-ghost" onClick={() => onNavigate?.('positioning')}>補做定位測驗</button>}
        <PromotionShare client={client} kind="platform" target="workshop" title="自由工坊" text="自由工坊：加入公會、領取 Repo 技能書，和夥伴一起供貨、開店與做開源作品。" label="分享自由工坊"/>
      </div>
    </section>
    <MemberRecommendations client={client}/>
    </aside>
    </div>
  </div>;
}
