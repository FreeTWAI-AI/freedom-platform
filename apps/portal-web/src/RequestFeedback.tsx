import {useEffect, useState, useSyncExternalStore} from 'react';
import {requestActivity} from './request-activity';
import {useLanguage} from './language';
import './RequestFeedback.css';

/** Transport state complements the form's own ACK, error and retry controls. */
export function RequestFeedback() {
  const {t} = useLanguage();
  const activity = useSyncExternalStore(requestActivity.subscribe, requestActivity.snapshot, requestActivity.snapshot);
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update); window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);
  // ConnectionStatus owns the single offline banner and its layout inset.
  if (!online || !activity.pending) return null;
  return <div className="request-feedback" role="status" aria-live="polite" aria-atomic="true">
    <span className="request-feedback-progress" aria-hidden="true"/>
    <span>{t(activity.mutations ? 'request.working' : 'request.reading')}</span>
  </div>;
}
