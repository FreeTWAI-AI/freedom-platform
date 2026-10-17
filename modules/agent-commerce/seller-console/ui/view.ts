import {formatMinor,parseMajorToMinor} from '../../../../apps/portal-web/src/format';
export {formatMinor as money};
export const words={
 payment:{unpaid:'待付款',pending:'付款確認中',confirmed:'已收款',overpaid:'收款與訂單不符，需處理',simulated:'模擬付款（不會出貨）',refunded:'已退款'},
 inventory:{held:'保留中',hold_expired:'保留已過期',allocated:'已配貨',partially_shipped:'部分出貨',shipped:'已出貨',released:'已釋出',unallocated:'已收款但缺貨，需處理'},
 lifecycle:{open:'進行中',cancelled:'已取消',closed:'已完成'},
 cancel:{buyer_cancelled:'買家取消',seller_cancelled:'店家取消',payment_not_completed:'付款未完成',paid_cancelled:'已付款訂單取消'},
 kind:{amount_mismatch:'收款金額不符',paid_after_cancel:'取消後收到付款',overpaid:'重複收款',paid_unallocatable:'已收款但缺貨，需處理',payment_unconfirmed:'付款待確認，請勿出貨',unmatched_payment:'付款找不到對應訂單',contradicting_event:'付款紀錄互相矛盾'},
 next:{refund_payment:'請在綠界後台退款，再登錄退款紀錄',allocate_or_refund:'請補貨後重新配貨；無法補貨請聯絡處理',check_with_provider:'請到綠界後台核對',contact_provider:'請立即查詢付款結果，並聯絡綠界核對'},
 resolution:{refunded:'已在綠界後台退款',allocated:'補貨後已重新配貨',confirmed:'付款已向綠界確認',checked_with_provider:'已在綠界後台核對'},
 service:{draft:'尚未開通',active:'使用中',suspended:'已暫停',retired:'已停用'},
 activation:{ready:'待前往驗證付款',awaiting_result:'等待驗證付款結果',paid:'已付款，等待查詢確認',confirmed:'驗證付款已確認',failed:'驗證付款未完成',expired:'驗證付款已到期'},
 attempt:{issued:'已建立',paid:'已收到付款',confirmed:'已向付款服務確認',failed:'付款未完成',superseded:'已由下一次付款取代',expired_unpaid:'已到期且未付款'},
 latest:{ready:'待前往付款',awaiting_result:'等待付款結果',paid:'已收到付款',failed:'付款未完成',expired:'付款已到期'},
 application:{converted:'已轉為配貨',allocated:'已配貨',unallocatable:'缺貨，尚未配貨',after_cancel:'取消後收款',overpaid:'重複收款',amount_mismatch:'收款金額不符',simulated:'模擬付款'},
 status:{open:'待處理',resolved:'已結案',dismissed:'已排除'},
} as const;
export const NOT_ALLOWED='你沒有這個操作的權限';
export const permissionHelp='請聯絡商店擁有者或管理員授予權限。';
export function amountToMinor(value:string,currency:string){if(!['TWD','USD'].includes(currency)||!/^\d+$(?![\s\S])/.test(value))throw Error('請輸入大於 0 的整數金額。');return parseMajorToMinor(value);}
export const setupNext:Record<string,string>={
 store_upgrade_unavailable:'目前無法升級，請更新商店版本資訊。',
 provider_account_not_found:'找不到這個收款帳戶，請更新帳戶清單。',
 provider_profile_invalid:'收款設定檔與服務用途不符，請重新設定。',
 admission_not_independent:'收款准入需由其他管理員確認，請聯絡平台。',admission_revoked:'收款准入已撤回，請聯絡平台。',store_admission_exists:'已有收款准入紀錄，請更新資料。',store_admission_unavailable:'目前無法確認收款准入，請稍後重試。',store_admission_not_found:'找不到收款准入，請聯絡平台。',
 capability_denied:'請聯絡商店擁有者或管理員授予權限。',not_found:'找不到這筆資料，請回到商店重新開啟。',tenant_not_found:'找不到這個業務空間，請切換商店。',tenant_capability_denied:'請聯絡業務空間擁有者或管理員授予權限。',
 storefront_unavailable:'商店目前無法使用，請聯絡擁有者或管理員。',idempotency_required:'操作缺少識別鍵，請重新開啟頁面。',version_required:'操作缺少資料版本，請更新資料後再送出。',
 session_expired:'登入已到期，請重新登入後確認結果。',principal_disabled:'帳號目前停用，請聯絡管理員。',scope_disabled:'業務範圍目前停用，請聯絡管理員。',admin_required:'這個操作需要管理員，請聯絡平台。',admin_csrf_rejected:'管理員驗證已失效，請重新驗證。',internal_error:'服務暫時無法完成操作，請稍後確認結果。',
 commerce_credentials_unavailable:'收款金鑰服務暫停，稍後再試',provider_environment_not_allowed:'帳戶環境與平台不符，請聯絡管理員。',provider_account_exists:'已有相同的綠界帳戶，請更新帳戶資料。',provider_activation_pending:'驗證付款仍在處理，請稍後更新帳戶狀態。',provider_service_state:'服務狀態已改變，請更新資料後確認可用操作。',provider_service_conflict:'已有相同設定檔的啟用服務，請先暫停舊服務。',commerce_quarantined:'收款服務暫停操作，請稍後再試。',commerce_rate_limited:'操作太頻繁，請稍後再試。',fresh_auth_required:'請重新輸入密碼驗證身分。',idempotency_conflict:'原操作的冪等鍵有衝突，請核對目前資料；系統不會自動重送。',version_conflict:'資料已更新，已重新讀取。請確認保留的輸入，再送出一次。',invalid_version:'版本無效，已重新讀取。請確認後再送出。',payment_result_pending:'暫時無法確認，請稍後再查詢',validation_failed:'請檢查欄位格式，再送出。',refund_exceeds_payment:'請更新退款餘額並調整金額。',refund_date_invalid:'請核對付款日期與退款日期。',stock_unavailable:'請補貨後再試。',refund_not_available:'這筆款項目前無法登錄退款，請更新訂單。',exception_action_unavailable:'案件狀態已改變，請更新案件。'};
