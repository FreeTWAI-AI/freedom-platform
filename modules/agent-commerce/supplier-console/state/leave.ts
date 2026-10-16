import {sameConsoleScope,type ConsoleScope} from '../ui/route';
export const DRAFT_LEAVE='還有尚未儲存的內容，要離開嗎？';
export function leaveDecision(next:string|null,scope:ConsoleScope,state:{sending:boolean;held:boolean;photoBlocking:boolean;materialBlocking?:boolean;dirty:boolean}) {
 if(next!==null&&sameConsoleScope(next,scope))return {allow:true,confirm:false,message:''};
 if(state.sending)return {allow:false,confirm:false,message:'正在確認原操作，請等候完成後再離開。'};
 if(state.held||state.photoBlocking||state.materialBlocking)return {allow:false,confirm:false,message:'尚未確認原操作的結果，請按「重試」確認後再離開。'};
 return {allow:true,confirm:state.dirty,message:state.dirty?DRAFT_LEAVE:''};
}
