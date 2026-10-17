// Synthetic interoperability test vector only: key bytes 0x00..0x1f and nonce
// bytes 0x00..0x0b. Never use this material for a deployed account.
export const CREDENTIAL_SEAL_VECTOR = Object.freeze({
  keyring:'vector:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
  context:{account_id:'00000000-0000-4000-8000-000000000001',purpose:'payment' as const,environment:'sandbox' as const,credential_version:1},
  material:{hash_key:'AAAAAAAAAAAAAAAA',hash_iv:'BBBBBBBBBBBBBBBB'},
  row:{key_id:'vector',sealed:'AAECAwQFBgcICQoLkHI1zrKDod9+ZFI+iK7YLTwgvnq2jZ1w6Di1sZOoOSzCl8Z1sToePXkmpMRcSyyQaXHdlPCoZLpOhj2vysVqeqwbIs8YlOGYfdUIZA=='},
});
