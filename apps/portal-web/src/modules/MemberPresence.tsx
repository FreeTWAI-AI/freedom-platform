import {formatIsoLocal} from '../format';
import './MemberPresence.css';

export function MemberPresence({online,lastSeen}:{online:boolean;lastSeen:string|null}){
  return <span className="member-presence"><span className="member-presence-state"><span className="member-presence-dot" aria-hidden="true" data-online={online}/>{online?'目前在線':'目前離線'}</span><span>{lastSeen?<><span>上次上線：</span><time dateTime={lastSeen}>{formatIsoLocal(lastSeen)}</time></>:'尚無上線紀錄'}</span></span>;
}
