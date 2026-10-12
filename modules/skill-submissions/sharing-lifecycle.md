# 開源作品分享的收尾邊界

會員從既有簡易投稿預覽、同意並公開，之後在作品卡管理介紹與撤下分享。
公會指定技能書仍由原選書流程管理；推薦別人的 Repo 不授予 Repo 管理權。

撤下以本人登錄的 project 為單位，檢查目前 session、owner、CSRF、命令 key
與 project version。先鎖本人投稿範圍，再鎖投稿與 project；publish、prepare
及 upgrade 使用相同順序。別人的同 Repo 登錄與公會獨立收錄不受影響。

同一交易撤回全部公開版本及其升級稿，撤銷未完成 upload grant，並設定原
project 的 sharing_withdrawn_at。公開 HTML、JSON、Agent 文件、圖片、舊版
轉址、技能書架、會員作品目錄與共創展示不再提供該份分享。GitHub history
目錄與同步不再由這份已撤下登錄納入 Repo；其他仍有效來源可獨立納入。
原始 GitHub Repo、已下載副本及既有私人協作／行銷快照不會被刪除。

本人保留介紹、來源版本與投稿歷史，可以編輯、準備新的私人草稿，再預覽
並同意公開。新的公開使用原 project ID 與新的投稿連結；已撤下的舊連結
維持缺少頁，不因再公開自動恢復。更新 GitHub 版本或修改文字不會解除撤下。
每次新 publication 都推進 project version，過期的撤下要求不能隱藏新發布。
命令重送不重複寫入；撤下 receipt 僅含 ID、版本與狀態，UI 另讀目前資料。

## 部署與恢復限制

Schema 165 增加既有 project 的可見性欄位。**正式部署尚未執行**。
啟用前必須在部署／恢復操作器保留 `opensource.sharing-visibility.v1` 與
schema 165 的 reader/writer floor，並實測拒絕舊版 rollback。舊 binary 的會員
目錄不認識撤下欄位，不能當作相容 rollback。此文件不是已安裝 floor 的證據。
備份須保留 project、全部 submission、grant 撤權與 asset 關係；還原後依
T-047 隔離及目前權限對帳，不自動重新開放。

本機合成測試、staging 驗收、正式發布與真人自主使用分別記錄；不能互相替代。
