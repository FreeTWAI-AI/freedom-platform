# SPEC-BLD-04 — Installer、cache、activation pointer 與三 CLI adapters

> 狀態：現行 canonical baseline（2026-09-17）；planning 文件，不代表已部署。

| 欄位 | 值 |
| --- | --- |
| Spec ID／狀態 | `SPEC-BLD-04`／draft-ready |
| 所屬 milestone／原 package | M02／`BLD-04` |
| Accountable role／implementation agent／AI reviewer／AI verifier | Agent Workflow；owner＝Ted（建議預設，五人共同閱讀確認）／韋銘＋Codex（implementation；建議預設，五人共同閱讀確認）／Grok／Claude |
| official reviewer（建議預設） | Mini 或 Jason（五人共同閱讀確認）；implementation＝韋銘時由非作者擔任，只控制 official evidence |

## 來源與需求 ID

[`06 §4.1.2 BLD-04`](../../06-delivery-plan.md)、[`08 §12`](../../08-bootstrap-hosting-project-lifecycle.md)、[`portable-activation.schema.json`](../../contracts/portable-activation.schema.json)、RQ-043/RQ-047；ADR-049；baseline。保留階段 1A contract／階段 1B implementation。

## 使用者結果與明確不包含

Codex、Claude、Grok 三個 adapter 從同一 signed bootstrap/current heads 與 policy chain 得到同一八輸入 activation digest；安裝失敗不破壞現有 pointer，live session 不混 N/N+1 bytes。不包含 channel/signing producer（BLD-03）、domain roots（BLD-05）、project lifecycle（PRJ-01）或 production KMS。

## Actor／principal／acting role／資源範圍

Person operator、launcher principal、三個 CLI adapter、installer/GC worker。只有 launcher 可切 atomic pointer；installer 寫 content-addressed cache，CLI native loader 只讀該 run 的 immutable root。

## 既有 canonical entity／command／event／state／projection

PortableActivation、bootstrap index、channel/revocation heads、ActivationRecord、content-addressed object、atomic pointer、live-session lease、network profile。命令：preflight→fetch/verify→safe extract→stage→atomic activate→acquire lease→load→release/GC；本 spec 不新增 event 名稱、不定義 activation 狀態，狀態集以 `08`／`portable-activation.schema.json` 為準；projection：active digest、reachable roots、leases、cache pressure。

## 正常／異常／卡點／取消／補件／爭議／恢復

正常：驗 exact current heads、closure、digests、network budget與path profile，安全解包到 flat read-only cache，原子切 pointer，session 取得 durable lease。異常：host candidate、unsafe archive、missing/extra file、old/forked head、revoked key/package、path/network cap或isolation不支援一律拒絕。取消/失敗保留原 pointer；crash 後由 journal/staging cleanup恢復，GC不得刪 reachable bytes。

## 授權／A4／independence／來源與版本綁定

installer 只接受 BLD-03 已驗的 signed channel chain；本地 cache 存在不構成 authority。adapter不得掃 cache、自動回退或自行挑版本；production trust 依賴 `08 §12` 的 technical planes。A4 release authority不能由 CLI success receipt取代。

## 版本與獨立驗收

三 adapter 對 exact bootstrap/current heads、active policy、closure與network profile做相同 canonicalization；independent golden parsers須得同 digest。階段 1A 凍結 contract schema／interface／fixtures；階段 1B 交付 skeleton／implementation 與可用 installer／adapters。

## 冪等／業務唯一鍵／並發／fencing／lease／時間

相同 activation digest 重試收斂同 cache object/pointer。pointer read到 durable lease 建立持同一 global lock；GC mark/sweep 保留 active pointer與持鎖 live leases。五種時間依 `03 §11`：invite／claim `expires_at`、delivery `due_at`、TaskLease／lease proof `expires_at`＋`fencing_token`、`ExecutionGrant.expires_at`、evidence `valid_until`；本 package 不直接涉及這五種 clock，portable activation authority TTL 與 live-session GC lease 不得代用。Payment release 與 retention 也不是 clock。併發 activate以 monotonic pointer generation/fence防舊 writer覆新值。

## UI／CLI／MCP

UI可顯示 active digest、來源、expiry/revocation、cache與 remediation。CLI介面：preflight/activate/status/rollback-safe-retain/gc；名稱待實作repo固定。MCP/adapter只能暴露已啟用 control capabilities，不能藉 host discovery繞過 immutable root。

## 隱私／憑證／資料保留與 provider 邊界

bundle/cache 不含 production secret；fetch credential短效、scope限定、不得寫 log或cache。retention與GC以 reachability/lease規則，不以任意mtime。三 CLI host path與使用者資料不得進 activation digest之外的遙測。

## 成本／可觀測性／timeout／retry／reconciliation

記錄各輸入 digest、download bytes、cache hit、activation latency、pointer generation、lease/GC、rejection class；邊界 fixture包含10 GiB cache、1 GiB reserve、64 leases、16 roots。retry沿 stable digest，不在timeout後換版本；reconcile pointer、leases與reachable set。

## 遷移／相容性／rollback

先以 fake trust root與non-production channel；階段 1B逐 adapter rollout。schema未知major、unsupported isolation fail closed。rollback只能切到仍符合 current policy/heads且未撤銷的已驗 root；不得自動回退。舊 cache可留到safe GC。

## Given–When–Then

1. Given 同一 signed inputs，When 三 adapter activate，Then 八輸入 digest與root bytes一致。
2. Given session持 N lease且 N+1 activate，When native loader重讀，Then 該session只見N；新session見N+1。
3. Given crash發生在stage與pointer rename間，When恢復，Then原 pointer仍有效且GC不刪其reachable bytes。
4. Given revoked/forked head或host shadow，When preflight，Then零 execution且提供安全 remediation。

## 實際測試命令（將來會這樣跑；未跑）

以下 `docs/platform-plan/contracts/tests/*.py` 均為（新建）路徑，目前尚不存在。

```bash
pytest -q docs/platform-plan/contracts/tests/test_three_cli_digest_parity.py
pytest -q docs/platform-plan/contracts/tests/test_pointer_lease_gc_faults.py
pytest -q docs/platform-plan/contracts/tests/test_archive_path_network_isolation_negatives.py
```

以上命令目前未跑，路徑是 future implementation contract，不是現存 tests。

## 缺 evidence 時的標籤／技術依賴

Implementation repo、三 CLI host adapter API與production signer／KMS未核對。階段 1A fixtures照常；階段 1B adapter需要repo與host API，production claim需要`08 §12` custody evidence與實際fault tests。

## 完成證據

階段 1A schema／interface／golden／negative fixtures；階段 1B三 CLI transcripts、activation digests、fault-injection、lease／GC reachability、revocation與rollback reports、Grok review與Claude verification。現在均不存在。
