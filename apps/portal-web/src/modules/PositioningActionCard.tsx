import { useId } from 'react';
import type { PositioningActionCard } from '../../../../modules/guild-workspace/positioning-action-card';

type Props = {
  value: PositioningActionCard;
  onChange: (value: PositioningActionCard) => void;
  onSave: () => void;
  disabled: boolean;
  readOnly: boolean;
  saved: boolean;
  error: string;
};

/** A small human-authored exercise; Work owns identity, grants, persistence and retries. */
export function PositioningActionCardForm({ value, onChange, onSave, disabled, readOnly, saved, error }: Props) {
  const prefix = useId();
  const locked = disabled || readOnly;
  function change(patch: Partial<PositioningActionCard>, plan = true) {
    onChange({ ...value, ...patch, ...(plan ? { personally_confirmed: false } : {}) });
  }
  function field(label: string, key: 'situation' | 'experience' | 'desired_change' | 'completion_criteria' | 'available_time' | 'support_needed' | 'review' | 'next_step', maxLength = 4000) {
    return <label className="field">{label}<textarea aria-label={label} value={value[key]} maxLength={maxLength} disabled={locked} rows={2}
      onChange={event => change({ [key]: event.target.value }, key !== 'review' && key !== 'next_step')} /></label>;
  }
  const ready = value.selected_activity !== null && Boolean(value.activities[value.selected_activity]?.trim())
    && Boolean(value.desired_change.trim() && value.completion_criteria.trim() && value.available_time.trim() && value.review_date);
  return <form className="stack production-project" aria-label="我的方向卡" onSubmit={event => { event.preventDefault(); if (!locked) onSave(); }}>
    <h4>我的方向卡</h4>
    <p className="field-hint">先選一件這週可以試的小事，寫清完成條件。可以先保存未填完的草稿，日後回到這份工作繼續。</p>
    <fieldset className="production-brief" disabled={locked}>
      <legend>這週想做什麼</legend>
      {field('這週想改變的事', 'desired_change')}
      {field('目前的情境', 'situation')}
      {field('我做過的事與可用經驗', 'experience')}
      {field('可投入時間', 'available_time', 500)}
    </fieldset>
    <fieldset className="stack" disabled={locked}>
      <legend>挑一個小活動</legend>
      {value.activities.map((activity, index) => <div className="stack" key={index}>
        <label className="field">小活動 {index + 1}<input aria-label={`小活動 ${index + 1}`} value={activity} maxLength={1000} onChange={event => {
          const activities = [...value.activities]; activities[index] = event.target.value;
          change({ activities, selected_activity: value.selected_activity === index && !event.target.value.trim() ? null : value.selected_activity });
        }} /></label>
        <label className="choice"><input type="radio" name={`${prefix}-activity`} checked={value.selected_activity === index} disabled={locked || !activity.trim()}
          onChange={() => change({ selected_activity: index })} />這週先試活動 {index + 1}</label>
      </div>)}
      <div className="my-work-actions">
        {value.activities.length === 1
          ? <button type="button" className="btn btn-ghost" onClick={() => change({ activities: [...value.activities, ''] })}>加一個備選活動</button>
          : <button type="button" className="btn btn-ghost" onClick={() => change({ activities: value.activities.slice(0, 1), selected_activity: value.selected_activity === 1 ? null : value.selected_activity })}>移除第二個活動</button>}
      </div>
    </fieldset>
    <fieldset className="production-brief" disabled={locked}>
      <legend>完成條件與回顧</legend>
      {field('怎樣算完成', 'completion_criteria')}
      {field('需要的協助', 'support_needed')}
      <label className="field">回顧日期<input aria-label="回顧日期" type="date" value={value.review_date} onChange={event => change({ review_date: event.target.value })} /></label>
      <label className="choice"><input type="checkbox" checked={value.personally_confirmed} disabled={locked || !ready}
        onChange={event => change({ personally_confirmed: event.target.checked }, false)} />這個小活動由我自己選定</label>
      {!ready && <p className="field-hint production-field-wide">填寫本週目標、選定活動、完成條件、時間與回顧日期後即可確認；現在也能保存草稿。</p>}
    </fieldset>
    <details>
      <summary>做完後的回顧與下一步</summary>
      <div className="stack">{field('實際發生的事與學到的事', 'review')}{field('我的下一步', 'next_step')}</div>
    </details>
    <p className="field-hint">{value.personally_confirmed ? '本人已確認活動' : '尚未確認的草稿'} · {saved ? '已有保存版本' : '尚未保存方向卡'}</p>
    {error && <p className="banner banner-error" role="alert">{error}</p>}
    {!readOnly && <button className="btn btn-primary my-work-primary" type="submit" disabled={locked}>儲存方向卡</button>}
  </form>;
}
