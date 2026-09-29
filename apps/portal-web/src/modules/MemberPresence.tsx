import {formatIsoLocal} from '../format';
import './MemberPresence.css';

export function MemberPresence({online,lastLogin}:{online:boolean;lastLogin:string|null}){
  return <span className="member-presence"><span className="member-presence-state"><span className="member-presence-dot" aria-hidden="true" data-online={online}/>{online?'目前在線':'目前離線'}</span><span>{lastLogin?<><span>上次登入：</span><time dateTime={lastLogin}>{formatIsoLocal(lastLogin)}</time></>:'尚無登入紀錄'}</span></span>;
}
