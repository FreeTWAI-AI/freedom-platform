# @freetwai/skill-upload

把技能草稿上傳到[自由工坊](https://freetwai.com)的小工具。它只能建立 **私人草稿**；公開、撤回與金鑰管理都由會員本人在網站操作。

沒有任何相依套件，需要 Node.js 24 以上。這個套件沒有發佈到 npm registry，請從自由工坊網站下載 tarball 後在本機安裝：

此安裝包標為 `private`／`UNLICENSED`：專案尚未提供 LICENSE，本工具不自行新增授權條款。安裝方式不代表取得額外重製或散布授權；投稿所引用的各 GitHub 專案仍依各自 LICENSE，公開可讀與官方身分分開判斷。

```sh
npm install -g ./freedom-skill-client.tgz
```

## 設定

1. 登入自由工坊，到「技能上傳」建立上傳金鑰（只顯示一次）。
2. 暫存金鑰的檔案需設為 `0600`，從 stdin 交給工具保存，不要寫在命令列或存進 repo：

```sh
freedom-skill-upload init --origin https://freetwai.com --key-stdin < key.txt
# 或
FREEDOM_SKILL_UPLOAD_KEY="$(cat key.txt)" freedom-skill-upload init --origin https://freetwai.com
```

金鑰會存到 `~/.config/freedom-skill-upload/config.json`（檔案 0600、資料夾 0700）。`freedom-skill-upload config` 只顯示網站與 `keyConfigured`，不會顯示金鑰；`freedom-skill-upload reset` 會刪除本機金鑰。若金鑰可能外流，請到網站撤銷。

## 上傳

```sh
freedom-skill-upload submit --file skill.json --cover cover.png
```

也可以用網站發出的一次性上傳授權，把內容送到指定草稿（授權不會保存）：

```sh
freedom-skill-upload submit --submission <草稿 ID> --grant-stdin --file skill.json < grant.txt
```

內容格式與規則見 [protocol.md](protocol.md)；給 AI agent 的操作指引見 [SKILL.md](SKILL.md)。

## 安全設計

- 只連到設定的網站（HTTPS，或本機測試用的 `http://127.0.0.1`／`localhost`／`[::1]`），不跟隨轉址，也不送 cookie。
- 命令列參數出現疑似金鑰時會直接停止，不會使用。
- 不輸出金鑰、授權或伺服器的原始回應內容。
