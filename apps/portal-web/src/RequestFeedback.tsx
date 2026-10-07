import {useEffect, useState, useSyncExternalStore} from 'react';
import {requestActivity} from './request-activity';
import './RequestFeedback.css';

/** Transport state complements the form's own ACK, error and retry controls. */
export function RequestFeedback() {
  const activity = useSyncExternalStore(requestActivity.subscribe, requestActivity.snapshot, requestActivity.snapshot);
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update); window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);
  if (online && !activity.pending) return null;
  return <div className={`request-feedback${online ? '' : ' is-offline'}`} role="status" aria-live="polite" aria-atomic="true">
    {online && <span className="request-feedback-progress" aria-hidden="true"/>}
    <span>{!online ? '目前離線，連線恢復後再試。' : activity.mutations ? '正在處理…' : '正在讀取…'}</span>
  </div>;
}
