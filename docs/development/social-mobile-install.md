# 手機安裝與主畫面入口

登入頁和會員設定提供「加入主畫面」。瀏覽器提供原生安裝提示時，只在使用者按「安裝自由工坊」後開啟；其他情況提供三步說明。帳號入口的五種語言皆有對應文字。取消或拒絕後仍可看說明；接受提示不提前聲稱安裝完成。

Manifest 的 id、start_url 與 scope 都是同源 `/`，使用 standalone 模式；192／512px 圖示及 iPhone 180px 圖示由既有原始品牌圖等比例置入，保留安全邊界。安裝不攜帶會員或重設密碼 URL。主題同步 theme-color；standalone 不重複顯示安裝入口。

聊天室使用既有手機 visual viewport 與 safe-area，縮小可用高度時保持標題、輸入和傳送在畫面內。斷線時有狀態提示；恢復網路保留目前頁面的草稿，發布／傳送仍需要本人操作。沒有 service worker、私人 API 快取、離線啟動、背景寫入佇列或推播；此版本需要網路。

六個 Chromium 案例涵蓋原生 manifest／installability 與 HTTP 圖示、320px 五語說明／焦點、真實斷線與重新連線，以及一次顯式 API 發文。Native prompt、standalone、瀏海與縮小 viewport 是明示模擬；實際 iPhone／Android 安裝、系統鍵盤與登入儲存仍待真人驗收。結果列於[本輪效能紀錄](social-platform-performance-2026-10-07.md)。
