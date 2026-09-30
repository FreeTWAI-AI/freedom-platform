// Keep in step with is_verification_test_email in migrations/051_verification_test_data.sql.
// Queries must call that function or the classification views, not a copied LIKE.
export const VERIFICATION_TEST_EMAIL_SUFFIX='@example.invalid';

export function isVerificationTestEmail(email:string){
  return email.trim().toLowerCase().endsWith(VERIFICATION_TEST_EMAIL_SUFFIX);
}
