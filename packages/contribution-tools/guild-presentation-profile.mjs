// Reviewed CI obligations for the two sample guilds. This is not an application
// registry or executable descriptor data; unknown guilds require a reviewed plan.
export const GUILD_PRESENTATION_PROFILE = Object.freeze({
  id: 'guild-presentation',
  leaves: Object.freeze([
    Object.freeze({module: 'guild-supply', owner: 'guild-supply-maintainer',
      entry: 'modules/guild-supply/CatalogBlock.tsx', dependencies: Object.freeze(['guild-presentation', 'hosted-distribution']),
      surface: 'guild-block.supply-catalog.v1', operation: 'storefront.supply-catalog.list'}),
    Object.freeze({module: 'guild-open-source', owner: 'guild-open-source-maintainer',
      entry: 'modules/guild-open-source/WorksBlock.tsx', dependencies: Object.freeze(['guild-presentation', 'personal-content']),
      surface: 'guild-block.open-source-works.v1', operation: 'community.personal-content-page.view'}),
  ]),
  runtimeSuite: 'runtime.guild-presentation',
  runtimeFiles: Object.freeze(['guild-blocks', 'guild-launchpad', 'guild-launchpad-contracts', 'guild-launchpad-profiles', 'launchpad-profile-defaults'].map(name => `tests/runtime/${name}.test.ts`)),
  integrationFiles: Object.freeze(['tests/e2e/guild-block-composition.spec.ts', 'tests/e2e/guild-launchpad.spec.ts', 'tests/e2e/guild-launchpad-profiles.spec.ts']),
  previewFiles: Object.freeze(['modules/guild-supply/CatalogBlock.spec.ts', 'modules/guild-open-source/WorksBlock.spec.ts']),
});
