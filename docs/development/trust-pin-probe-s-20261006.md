# Trust-pin upgrade probe S (synthetic)

這份文件只供 2026-10-06 中央 trust pin 升級驗收使用，目標是一次性分支
`ops/trust-pin-d1c9-base-20261006`，不是產品變更，也不可指向 main。

Case: pin supersession. The first head runs under the old pinned workflow
(c3e5a537). After the probe ruleset moves to d1c9e18f, that old run must not
satisfy the new pin.
