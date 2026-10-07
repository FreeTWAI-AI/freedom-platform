/** Reviewed source pins. A later release is a new row; these constants do not change. */
export const WORK_CONTRACT_SOURCE_COMMIT = '5ccd76c347a137ef896ffc266168c0e89cc5b575';
export const WORK_CONTRACT_ARTIFACT_SHA256 = '8c121e2b2aa05a233f0402209ea75093252f383f337200a3d2707160a0278142';
export const EMPTY_CONFIG_DIGEST = '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a';
export const MANUAL_WORKSPACE_RELEASE = 'manual-workspace@1.0.0';
export const WORK_MODULE_RELEASE = 'work@1.0.0';
export const PLAN_TTL_MS = 15 * 60 * 1000;
export const MAX_STEP_ATTEMPTS = 12;
export const STEP_WINDOW_MS = 24 * 60 * 60 * 1000;
export const STEP_LEASE_MS = 30 * 1000;
export const RETRY_BASE_MS = 10 * 1000;

export const WORK_CAPABILITIES = Object.freeze([
  'work:create', 'work:read', 'work:write', 'work:archive', 'work:result.write',
] as const);

export const WORK_CONTRACT = Object.freeze({
  family: 'guild-launchpad.tenant-work',
  version: '1',
  source_commit: WORK_CONTRACT_SOURCE_COMMIT,
  artifact_sha256: WORK_CONTRACT_ARTIFACT_SHA256,
  behavior_profile: 'freedom.tenant-work/v1',
});

export const MANUAL_WORKSPACE_LAUNCH_POLICY = Object.freeze({
  policy_key: 'manual-workspace.launch',
  version: '1',
});

export const WORK_REQUIREMENT = Object.freeze({
  requirement_key: 'work',
  module_key: 'work',
  module_release_ref: WORK_MODULE_RELEASE,
  capabilities: WORK_CAPABILITIES,
  required: true,
  cardinality: 'one' as const,
  allow_reuse: true,
  compatible_contracts: Object.freeze([WORK_CONTRACT]),
});

/** behavior_profile contains a slash, so it is not a StableKey. Zod and SQL allow that slash. */
export const CONFIG_SCHEMA_REFS = Object.freeze([
  'manual-workspace.config/v1',
  'work.config/v1',
  'synthetic-storefront.config/v1',
  'synthetic-inventory.config/v1',
] as const);

export type ContractRef = {
  family: string;
  version: string;
  source_commit: string;
  artifact_sha256: string;
  behavior_profile: string;
};

export type Requirement = {
  requirement_key: string;
  module_key: string;
  /** Stored on the definition. Stripped before the public requirement schema. */
  module_release_ref?: string;
  capabilities: readonly string[];
  required: boolean;
  cardinality: 'one';
  allow_reuse: boolean;
  compatible_contracts: readonly ContractRef[];
};
