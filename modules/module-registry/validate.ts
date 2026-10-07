import { Problem } from '../../packages/shared/problem.js';
import { CONFIG_SCHEMA_REFS, type ContractRef } from './definitions.js';

const SECRET_KEY = /secret|endpoint|password|credential|sql|javascript/i;
const PROTO_KEY = new Set(['__proto__', 'constructor', 'prototype']);

export function sameContract(left: ContractRef, right: ContractRef): boolean {
  return left.family === right.family && left.version === right.version
    && left.source_commit === right.source_commit && left.artifact_sha256 === right.artifact_sha256
    && left.behavior_profile === right.behavior_profile;
}

export function coversCapabilities(have: readonly string[], need: readonly string[]): boolean {
  return need.every(capability => have.includes(capability));
}

/**
 * Requirement order is the dependency convention: the last requirement is the
 * caller and each earlier requirement is one of its providers. The dependency
 * capability is that provider requirement's first capability, so a provider
 * with an empty list cannot be loaded.
 */
export function assertProviderCapabilities(requirements: readonly { capabilities?: readonly unknown[] }[]) {
  for (const requirement of requirements.slice(0, -1)) {
    if (!Array.isArray(requirement.capabilities) || requirement.capabilities.length === 0) {
      throw new Problem(409, 'application_not_available', '這個應用目前無法啟動。');
    }
  }
}

function depthOf(value: unknown, depth: number): number {
  if (depth > 8 || !value || typeof value !== 'object') return depth;
  const nested = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  return nested.reduce((max, item) => Math.max(max, depthOf(item, depth + 1)), depth);
}

function rejectKeys(value: unknown) {
  if (!value || typeof value !== 'object') return;
  const entries = Array.isArray(value) ? value : Object.keys(value as Record<string, unknown>);
  if (!Array.isArray(value)) {
    for (const key of entries as string[]) {
      if (PROTO_KEY.has(key) || SECRET_KEY.test(key)) {
        throw new Problem(422, 'configuration_invalid', '設定內容不符合這個版本的設定格式。');
      }
      rejectKeys((value as Record<string, unknown>)[key]);
    }
  } else {
    for (const item of value) rejectKeys(item);
  }
}

/** Pinned config schemas in this slice are empty strict objects. Unknown refs are invalid. */
export function assertConfiguration(value: unknown, schemaRef: string) {
  if (!(CONFIG_SCHEMA_REFS as readonly string[]).includes(schemaRef)) {
    throw new Problem(422, 'configuration_invalid', '設定內容不符合這個版本的設定格式。');
  }
  let encoded = '';
  try { encoded = JSON.stringify(value ?? null); } catch {
    throw new Problem(422, 'configuration_invalid', '設定內容不符合這個版本的設定格式。');
  }
  if (new TextEncoder().encode(encoded).length > 32 * 1024 || depthOf(value, 0) > 8) {
    throw new Problem(422, 'configuration_invalid', '設定內容不符合這個版本的設定格式。');
  }
  rejectKeys(value);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value as object).length > 0) {
    throw new Problem(422, 'configuration_invalid', '設定內容不符合這個版本的設定格式。');
  }
}

export function planStale(): Problem {
  return new Problem(409, 'plan_stale', '這份啟動計畫已過期或不再符合目前的目錄。');
}

export function mapRegistryError(error: unknown): never {
  const code = typeof error === 'object' && error && 'code' in error ? String((error as { code: unknown }).code) : '';
  const message = typeof error === 'object' && error && 'message' in error ? String((error as { message: unknown }).message) : '';
  if (code === '23505' && message.includes('application_installations_one_live')) throw planStale();
  if (code === '23505' && message.includes('workspace_module_bindings')) {
    throw new Problem(409, 'workspace_binding_conflict', '這個工作區已經綁定另一個工作實例。');
  }
  if (code === '23514' && message.includes('cycle')) throw new Problem(422, 'dependency_cycle', '模組依賴不能形成循環。');
  throw error;
}
