import type {Config} from '../../contracts/guild-launchpad/v2/config';

type GuardedKind = 'applications' | 'my_work';
type LeaveGuards = Partial<Record<GuardedKind, (() => boolean) | null>>;

/** A changed section key also unmounts its pending editor, even if its kind remains. */
export function canReplaceLaunchpadLayout(current: Config | null, next: Config, guards: LeaveGuards): boolean {
  for (const kind of ['applications', 'my_work'] as const) {
    const visible = (config: Config) => config.blocks.find(block => block.kind === kind
      && (block.enabled || kind === 'my_work' && config.schema_version === 'guild-launchpad.config/v1'));
    const before = current && visible(current);
    const after = visible(next);
    if (before && (!after || after.id !== before.id) && guards[kind]?.() === false) return false;
  }
  return true;
}
