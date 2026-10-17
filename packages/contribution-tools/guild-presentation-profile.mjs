// Reviewed CI obligations for the two sample guilds. This is not an application
// registry or executable descriptor data; unknown guilds require a reviewed plan.
export const GUILD_PRESENTATION_IMPORTS = Object.freeze({
  'modules/guild-supply/CatalogBlock.tsx': "import React from 'react';\nimport {MyStoresPageSchema} from '../../contracts/guild-launchpad/v1/storefront-pagination';\nimport {SupplierSummarySchema} from '../../contracts/guild-launchpad/v1/supplier-console';\nimport {useGuildRead, type GuildBlockProps} from '../../packages/guild-presentation/block';\nimport {GuildBlockState} from '../../apps/portal-web/src/guild-blocks/GuildBlockState';\n\n",
  'modules/guild-open-source/WorksBlock.tsx': "import React from 'react';\nimport {z} from 'zod';\nimport {useGuildRead, type GuildBlockProps} from '../../packages/guild-presentation/block';\nimport {GuildBlockState} from '../../apps/portal-web/src/guild-blocks/GuildBlockState';\n\n",
});

// Deliberately conservative admission, not a JS security sandbox/parser. A new
// dependency (or unfamiliar import syntax) requires the full reviewed lane.
// False positives in text/comments only make verification broader.
// Match `from` as a word too; parsing intervening comments is unnecessary and
// nested repetition could make malformed candidate input expensive to inspect.
export function guildPresentationImportsProven(path, source) {
  const prefix = GUILD_PRESENTATION_IMPORTS[path];
  return typeof source === 'string' && source.length <= 262144 && typeof prefix === 'string'
    && source.startsWith(prefix) && !/\b(?:import|require|eval|Function|Worker|SharedWorker|constructor|from)\b/.test(source.slice(prefix.length));
}

export const GUILD_PRESENTATION_PROFILE = Object.freeze({
  id: 'guild-presentation',
  leaves: Object.freeze([
    Object.freeze({module: 'guild-supply', owner: 'guild-supply-maintainer',
      entry: 'modules/guild-supply/CatalogBlock.tsx', dependencies: Object.freeze(['guild-presentation', 'hosted-distribution', 'supplier-console']),
      surface: 'guild-block.supply-catalog.v1', operations: Object.freeze(['storefront.supply-catalog.list', 'supplier-console.summary'])}),
    Object.freeze({module: 'guild-open-source', owner: 'guild-open-source-maintainer',
      entry: 'modules/guild-open-source/WorksBlock.tsx', dependencies: Object.freeze(['guild-presentation', 'personal-content']),
      surface: 'guild-block.open-source-works.v1', operations: Object.freeze(['community.personal-content-page.view'])}),
  ]),
  runtimeSuite: 'runtime.guild-presentation',
  runtimeFiles: Object.freeze(['guild-blocks', 'guild-launchpad', 'guild-launchpad-contracts', 'guild-launchpad-profiles', 'launchpad-profile-defaults'].map(name => `tests/runtime/${name}.test.ts`)),
  integrationFiles: Object.freeze(['tests/e2e/guild-block-composition.spec.ts', 'tests/e2e/guild-launchpad.spec.ts', 'tests/e2e/guild-launchpad-profiles.spec.ts']),
  previewFiles: Object.freeze(['modules/guild-supply/CatalogBlock.spec.ts', 'modules/guild-open-source/WorksBlock.spec.ts', 'modules/guild-events/EventsBlock.spec.ts']),
});
