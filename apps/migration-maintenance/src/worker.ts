// Temporary write-freeze Worker for the platform PostgreSQL relocation window.
// Every method and path (pages, assets, API, webhooks) gets the same fixed 503.
// It never reads the request URL, headers or body, and has no bindings, secrets,
// DB access, auth or outbound calls. Root attaches a zone route only while the
// DB and background tasks drain, then restores the normal route.
const MESSAGE='自由工坊正在進行資料庫維護，暫停服務與寫入，請稍後再試。\n';
const RETRY_AFTER_SECONDS='600';
export default {
 fetch(request:Request):Response{
  return new Response(request.method==='HEAD'?null:MESSAGE,{status:503,headers:{
   'Content-Type':'text/plain; charset=utf-8',
   'Cache-Control':'no-store',
   'Retry-After':RETRY_AFTER_SECONDS,
   'X-Content-Type-Options':'nosniff'
  }});
 }
};
