# Trust-pin upgrade probe n (synthetic)

這份文件只供 2026-10-06 中央 trust pin 升級驗收使用，目標是一次性分支
`ops/trust-pin-d1c9-base-20261006`，不是產品變更，也不可指向 main。

Case: new base. Green on the original base; after another probe merges, strict freshness must refuse the stale head until a new run on the updated base succeeds.
