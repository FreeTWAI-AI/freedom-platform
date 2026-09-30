import {createHmac} from 'node:crypto';
import {Problem} from '../shared/problem.js';
import type {AdminAccessVerifier} from '../../modules/platform-admin/access.js';

/** Browser-test admin identity. Production Access verification does not use this token. */
export const E2E_AUTHOR_CLAIM_ADMIN_TOKEN = 'e2e-author-claims-admin';
export const E2E_AUTHOR_CLAIM_ADMIN_EMAIL = 'claims-admin@example.invalid';

export const e2eAuthorClaimAdminVerifier: AdminAccessVerifier = async request => {
  if (request.headers.get('Cf-Access-Jwt-Assertion') !== E2E_AUTHOR_CLAIM_ADMIN_TOKEN) {
    throw new Problem(401, 'admin_identity_required', '請先通過平台管理員的信箱驗證。');
  }
  return {
    email: E2E_AUTHOR_CLAIM_ADMIN_EMAIL,
    subject: 'e2e-author-claims-admin',
    csrfToken: createHmac('sha256', 'e2e-author-claims-admin-csrf-secret-32').update(E2E_AUTHOR_CLAIM_ADMIN_TOKEN).digest('base64url'),
  };
};
