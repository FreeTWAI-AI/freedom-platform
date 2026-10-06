# Module registry notes

- Do not import the asset engine from this module. Capacity checks that uploads need live in `modules/opportunity-project-work/tenant-capacity.ts`.
- Do not put a synthetic capacity inserter in product code. Tests and the e2e server insert the disposable platform-default row.
- Enablement locks the workspace row `FOR UPDATE` before the instances advisory lock, so two first enables of one workspace serialize and the loser reuses the committed binding.
- Journal the new binding once. Returning an existing binding must not write another fact at the same version.
- `contract_ref` stays null. Do not add it to the instance view.
- Guild catalog keys are validated against `positioning_guild_catalog`. There is no category column and no community column on the catalog.
