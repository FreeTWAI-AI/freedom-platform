import {ApiError} from './api';
import {interfaceText,type InterfaceLanguage} from './language';
import type {InterfaceMessage} from './interface-messages';

const codes:Record<string,InterfaceMessage>={
  invalid_credentials:'error.credentials',login_rate_limited:'error.loginLimit',
  session_expired:'error.expired',login_required:'error.expired',
  reset_link_invalid:'error.resetLink',password_length:'error.validation',
  validation_error:'error.validation',email_exists:'error.emailUsed',email_taken:'error.emailUsed',
  account_unavailable:'error.registerUnavailable',
};
/** Presentation only: keep the API error, status and authority decisions intact. */
export function authErrorMessage(cause:unknown,language:InterfaceLanguage):string{
  const original=cause instanceof Error?cause.message:typeof (cause as {message?:unknown})?.message==='string'?(cause as {message:string}).message:'';
  if(language==='zh-Hant')return original||interfaceText(language,'error.generic');
  let key:InterfaceMessage='error.generic';
  if(original==='兩次輸入的新密碼不一致。')key='error.passwordMismatch';
  else if(original==='登入回應不完整')key='error.sessionIncomplete';
  else if(original==='登入已過期，請重新登入。')key='error.expired';
  else if(original==='密碼已重設，請用新密碼登入。')key='auth.resetDone';
  if(cause instanceof ApiError){
    if(cause.accessExpired)key='error.access';
    else if(cause.code&&codes[cause.code])key=codes[cause.code];
    else if(cause.timedOut)key='error.timeout';
    else if(cause.network)key='error.network';
    else if(cause.status>=500)key='error.unavailable';
    else if(cause.status===401)key='error.expired';
    else if(cause.status===403)key='error.notAllowed';
    else if(cause.status===422)key='error.validation';
    else if(cause.status===429)key='error.rateLimit';
  }else if((cause as {accessExpired?:boolean})?.accessExpired)key='error.access';
  else if((cause as {network?:boolean})?.network)key='error.network';
  return interfaceText(language,key);
}
