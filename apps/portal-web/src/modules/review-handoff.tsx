import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { PullDetail } from './review-center-shared';

export type HandoffCli = 'claude' | 'codex' | 'grok';
export type HandoffResult = {
  handoff_id: string; kind: string; cli: string; file_name: string; command: string; markdown: string; created_at: string;
};
export type IssueRepo = { id: string; full_name: string };
type PullBody = { kind: 'fix' | 'merge'; cli: HandoffCli; expected_head_sha: string };
type IssueBody = { issue_number: number; cli: HandoffCli };

const CLI_KEY = 'freedom-handoff-cli';
const CLI_OPTIONS: Array<[HandoffCli, string]> = [
  ['claude', 'Claude Code'], ['codex', 'Codex CLI'], ['grok', 'grok CLI'],
];
const HINT = 'AI 會用你自己的 GitHub 登入（gh）操作；權限不夠時 GitHub 會拒絕，AI 會停下來回報。合併前 AI 會重新檢查 CI、核准與 migration 編號，有一項不符就不合併。';
const KIND_LABEL: Record<string, string> = { fix: '讓 AI 修', merge: '讓 AI 合併', issue: '把 Issue 做成 PR' };

function readCli(): HandoffCli {
  try {
    const value = localStorage.getItem(CLI_KEY);
    if (value === 'claude' || value === 'codex' || value === 'grok') return value;
  } catch { /* private mode or a blocked storage */ }
  return 'claude';
}
function rememberCli(cli: HandoffCli) {
  try { localStorage.setItem(CLI_KEY, cli); } catch { /* private mode or a blocked storage */ }
}
function failure(error: unknown) {
  return error instanceof Error ? error.message : '無法產生任務。';
}

function HandoffResultView({ result, onAgain }: { result: HandoffResult; onAgain: () => void }) {
  const [copyNote, setCopyNote] = useState('');
  async function copy(text: string, fallback: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopyNote('已複製。');
    } catch {
      setCopyNote(fallback);
    }
  }
  function download() {
    const blob = new Blob([result.markdown], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = result.file_name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <div className="stack">
    <p>任務已產生（交接編號 {result.handoff_id.slice(0, 8)}）。在這個 repo 的本機資料夾執行：</p>
    <code className="handoff-command">{result.command}</code>
    <div className="actions">
      <button type="button" className="btn btn-ghost" onClick={download}>下載任務檔</button>
      <button type="button" className="btn btn-ghost" onClick={() => void copy(result.command, '無法複製指令，請手動選取上方指令。')}>複製指令</button>
      <button type="button" className="btn btn-ghost" onClick={() => void copy(result.markdown, '無法複製任務內容，請從預覽裡手動選取。')}>複製任務內容</button>
      <button type="button" className="btn btn-ghost" onClick={onAgain}>再產生一個</button>
    </div>
    {copyNote && <p className="field-hint" role="status">{copyNote}</p>}
    <p className="field-hint">{HINT}</p>
    <details>
      <summary>預覽任務內容</summary>
      <pre>{result.markdown}</pre>
    </details>
  </div>;
}

function CliField({ cli, onChange }: { cli: HandoffCli; onChange: (cli: HandoffCli) => void }) {
  return <label className="field">工具
    <select aria-label="工具" value={cli} onChange={event => {
      const next = event.target.value === 'codex' || event.target.value === 'grok' ? event.target.value : 'claude';
      rememberCli(next);
      onChange(next);
    }}>{CLI_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
  </label>;
}

export function PullHandoffButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return <button type="button" className="btn btn-ghost" aria-expanded={open} onClick={onToggle}>交給本機 AI…</button>;
}

export function PullHandoffForm({ detail, submit, onRefresh }: {
  detail: PullDetail;
  submit: (body: PullBody, key: string) => Promise<HandoffResult>;
  onRefresh: () => void;
}) {
  const handoff = detail.handoff;
  const [cli, setCli] = useState<HandoffCli>(readCli);
  const [kind, setKind] = useState<'fix' | 'merge'>('fix');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<HandoffResult | null>(null);
  const key = useRef(crypto.randomUUID());
  async function generate(event: FormEvent) {
    event.preventDefault();
    if (kind === 'merge' && !handoff.merge_allowed) return;
    setPending(true);
    setError('');
    try {
      const value = await submit({ kind, cli, expected_head_sha: detail.head_sha }, key.current);
      key.current = crypto.randomUUID();
      setResult(value);
      onRefresh();
    } catch (cause) {
      setError(failure(cause));
    } finally {
      setPending(false);
    }
  }
  function again() {
    key.current = crypto.randomUUID();
    setError('');
    setResult(null);
  }
  return <div className="handoff-panel stack">
    {!handoff.allowed && <p className="field-hint">{handoff.reason}</p>}
    {handoff.allowed && !result && <form className="stack" onSubmit={event => void generate(event)}>
      {error && <p className="banner banner-error" role="alert">{error}</p>}
      <label className="field">工作
        <select aria-label="工作" value={kind} onChange={event => setKind(event.target.value === 'merge' ? 'merge' : 'fix')}>
          <option value="fix">讓 AI 修這個 PR</option>
          <option value="merge" disabled={!handoff.merge_allowed}>讓 AI 合併這個 PR</option>
        </select>
      </label>
      {!handoff.merge_allowed && handoff.merge_reason && <p className="field-hint">{handoff.merge_reason}</p>}
      <CliField cli={cli} onChange={setCli} />
      <div className="actions"><button className="btn btn-primary" disabled={pending}>產生任務</button></div>
    </form>}
    {result && <HandoffResultView result={result} onAgain={again} />}
    {!!handoff.recent.length && <div className="stack">
      <h4>最近的交接</h4>
      <ul aria-label="最近的交接">{handoff.recent.map(item => {
        const tool = CLI_OPTIONS.find(([value]) => value === item.cli)?.[1] ?? item.cli;
        const when = item.created_at ? new Date(item.created_at).toLocaleString('zh-TW') : '';
        const sha = item.head_sha ? item.head_sha.slice(0, 7) : '';
        return <li key={`${item.created_at ?? ''}-${item.kind}-${item.github_login}-${sha}`}>{(KIND_LABEL[item.kind] ?? item.kind)} · {tool} · @{item.github_login}{sha ? ` · ${sha}` : ''}{when ? ` · ${when}` : ''}</li>;
      })}</ul>
    </div>}
  </div>;
}

export function IssueHandoff({ repositories, submit, blockedReason }: {
  repositories: IssueRepo[];
  submit: (repositoryId: string, body: IssueBody, key: string) => Promise<HandoffResult>;
  blockedReason?: string;
}) {
  const [repositoryId, setRepositoryId] = useState(repositories[0]?.id ?? '');
  useEffect(() => {
    if (!repositories.some(repo => repo.id === repositoryId)) setRepositoryId(repositories[0]?.id ?? '');
  }, [repositories, repositoryId]);
  const [issue, setIssue] = useState('');
  const [cli, setCli] = useState<HandoffCli>(readCli);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<HandoffResult | null>(null);
  const key = useRef(crypto.randomUUID());
  async function generate(event: FormEvent) {
    event.preventDefault();
    if (!/^[1-9][0-9]{0,9}$/.test(issue.trim()) || Number(issue) > 1_000_000_000) {
      setError('請填正整數的 Issue 編號。');
      return;
    }
    setPending(true);
    setError('');
    try {
      const value = await submit(repositoryId, { issue_number: Number(issue), cli }, key.current);
      key.current = crypto.randomUUID();
      setResult(value);
    } catch (cause) {
      setError(failure(cause));
    } finally {
      setPending(false);
    }
  }
  function again() {
    key.current = crypto.randomUUID();
    setError('');
    setIssue('');
    setResult(null);
  }
  return <details className="review-settings handoff-panel">
    <summary>把 Issue 做成 PR</summary>
    <div className="stack">
      {blockedReason ? <p className="field-hint">{blockedReason}</p> : result ? <HandoffResultView result={result} onAgain={again} /> : <form className="stack" onSubmit={event => void generate(event)}>
        {error && <p className="banner banner-error" role="alert">{error}</p>}
        <label className="field">儲存庫
          <select aria-label="交接儲存庫" value={repositoryId} onChange={event => setRepositoryId(event.target.value)}>
            {repositories.map(repo => <option key={repo.id} value={repo.id}>{repo.full_name}</option>)}
          </select>
        </label>
        <label className="field">Issue 編號
          <input aria-label="Issue 編號" inputMode="numeric" value={issue} onChange={event => setIssue(event.target.value)} required />
        </label>
        <CliField cli={cli} onChange={setCli} />
        <div className="actions"><button className="btn btn-primary" disabled={pending || !repositoryId}>產生任務</button></div>
      </form>}
    </div>
  </details>;
}
