/** Public deterministic test data. Never configure a deployed runtime with this key. */
export const TENANT_CURSOR_TEST_KEY = Buffer.alloc(32, 0x54).toString('base64url');
