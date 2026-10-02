// Central, reviewed suite IDs only. Descriptor data never supplies executable
// paths, arguments or commands. Full coverage retains this baseline and also
// discovers new direct *.test.ts files; deleting baseline tests is not a pass.
const paths = names => names.map(name => `tests/runtime/${name}.test.ts`);
export const RUNTIME_SUITES = Object.freeze(Object.fromEntries(Object.entries({
  'runtime.command-core': ['command-core'],
  'runtime.resource-scopes': ['resource-scopes'],
  'runtime.scoped-member-command': ['scoped-member-command'],
  'runtime.avatar': ['avatar', 'image-runtime', 'image-cloudflare'],
  'runtime.member-card': ['member-ecard', 'member-directory', 'social-links'],
  'runtime.work': ['flows', 'benefits', 'co-creation'],
  'runtime.work-privacy': ['work-privacy'],
}).map(([id, names]) => [id, Object.freeze(paths(names))])));

export const FULL_RUNTIME_BASELINE = Object.freeze(paths(`
admin-access-session admin-access-sync admin-access admin-appointments admin-guild-candidates admin-sync-worker
agent-commerce asset-lifecycle-races asset-lifecycle asset-storage avatar benefits client-connections co-creation
command-core commerce development-access-grant-race development-access development-map e2e-auth-isolation
event-highlights events-past flows freedom_env game-console-feed game-console-routing game-console
github-app-setup github-history github-identity github-repository-read github-social-routes github-social-store
github-social github-sync guild-entry-questions guild-experts guild-member-tiers guild-preferences guild-profile
guild-workspace identity-member image-cloudflare image-runtime link-preview maintainer-worker member-channel-access
member-channels-core member-communications member-connections member-directory member-ecard member-experience
member-services member-skill-registration notification-events onboarding-diagnostics onboarding opensource-marketing
page-github page-issue-label page-tools-notification password-hash password-recovery platform-admin platform-credentials
portal-client-recovery positioning preview-protocol published-skills repo-author-claims repo-maintainer-admin
repo-maintainer-claims repo-maintainer-guild repo-maintainer-handoff repo-maintainer-policy repo-maintainer-sync
repo-maintainer-webhook resource-scopes scoped-member-command share-promotion skill-book-guides skill-book-upstreams
skill-collaboration skill-discovery skill-share-content skill-sharing skill-submission-upgrades skill-submissions
skill-upload-chat skill-upload-client social-links squad-invitations verification-test-data work-privacy worker-adapter
`.trim().split(/\s+/)).sort());
