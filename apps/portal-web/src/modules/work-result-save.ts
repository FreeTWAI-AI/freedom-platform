import type { Operation, UploadView } from '../../../../contracts/guild-launchpad/v1/tenant-work';
import type { PortalClient } from '../api';
import { putWorkResultContent, type ResultContentType } from './work-result-client';

export type WorkResultSaveAttempt = {
  phase: 'prepare' | 'put' | 'finalize' | 'confirm';
  key: string;
  bytes: Uint8Array;
  sha256: string;
  contentType: ResultContentType;
  displayName: string;
  expectedWorkVersion: string;
  sourceText: string | null;
  uploadId?: string;
  uploadVersion?: string;
  putVersion?: string;
  resultId?: string;
};
export async function workResultDigest(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Existing Work uploader: checkpoint every acknowledged phase, retry the same bytes/key after uncertain outcomes. */
export async function advanceWorkResultSave(
  client: PortalClient,
  scope: { tenantId: string; workId: string },
  attempt: WorkResultSaveAttempt,
  call: { signal?: AbortSignal; live: () => boolean },
  checkpoint: (attempt: WorkResultSaveAttempt) => void,
  stage: (value: string) => void,
): Promise<WorkResultSaveAttempt | null> {
  const base = `/tenants/${scope.tenantId}/works/${scope.workId}/results/uploads`;
  let current = attempt;
  const keep = (next: WorkResultSaveAttempt) => { current = next; checkpoint(next); };
  if (!call.live() || call.signal?.aborted) return null;
  if (current.phase === 'prepare') {
    stage('上傳中…');
    const operation = await client.post<Operation>(base, {
      content_type: current.contentType, byte_size: current.bytes.byteLength, sha256: current.sha256,
      display_name: current.displayName, expected_work_version: current.expectedWorkVersion,
    }, { idempotencyKey: current.key, signal: call.signal });
    if (!call.live()) return null;
    keep({ ...current, uploadId: operation.resource_ref.resource_id, phase: 'put' });
  }
  if (current.phase === 'put') {
    stage('上傳中…');
    if (!current.uploadVersion) {
      const upload = await client.get<UploadView>(`${base}/${current.uploadId}`, { signal: call.signal });
      if (!call.live()) return null;
      keep({ ...current, uploadVersion: upload.version });
    }
    const verified = await putWorkResultContent(client, `/api/v1${base}/${current.uploadId}/content`, current.bytes, current.contentType, current.uploadVersion!, current.key, call.signal);
    if (!call.live()) return null;
    keep({ ...current, putVersion: verified.version, phase: 'finalize' });
  }
  if (current.phase === 'finalize') {
    stage('核對中…');
    const operation = await client.post<Operation>(`${base}/${current.uploadId}/finalize`, { expected_work_version: current.expectedWorkVersion }, {
      idempotencyKey: current.key, ifMatch: current.putVersion, signal: call.signal,
    });
    if (!call.live()) return null;
    keep({ ...current, resultId: operation.resource_ref.resource_id, phase: 'confirm' });
  }
  return current;
}
