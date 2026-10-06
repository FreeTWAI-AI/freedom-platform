# Trust-pin upgrade probe R (synthetic)

這份文件只供 2026-10-06 中央 trust pin 升級驗收使用，目標是一次性分支
`ops/trust-pin-d1c9-reopen-base-20261006`，不是產品變更，也不可指向 main。

Case: close and reopen. After the pin moves, reopening the pull request without a
new commit must run the new pinned workflow before the merge is accepted.
