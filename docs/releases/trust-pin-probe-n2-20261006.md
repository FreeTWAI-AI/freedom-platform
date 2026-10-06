# Trust-pin upgrade probe N2 (synthetic)

這份文件只供 2026-10-06 中央 trust pin 升級驗收使用，目標是一次性分支
`ops/trust-pin-d1c9-base-20261006`，不是產品變更，也不可指向 main。

Case: strict freshness. This head starts from the earlier base and does not
conflict with the probe merged since. Its own run passes, but strict required
checks must refuse it until the branch contains the current base and a new run passes.
