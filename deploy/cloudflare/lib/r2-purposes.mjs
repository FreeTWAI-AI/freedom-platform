/** Purpose is content policy, NOT an R2 public ACL. Both origins remain private. */
export const R2_PURPOSE_BINDINGS = Object.freeze({ 'member-private': 'MEDIA', 'platform-public': 'GUIDE_STATIC' });
export function purposeBuckets(environment) {
  const entries = environment?.r2_buckets;
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 2) throw Error('canonical_r2_purpose_mapping_invalid');
  const result = {}, names = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).some(key => !['name', 'public', 'optional', 'purpose', 'binding', 'referenced_preexisting'].includes(key))
      || entry.public !== false || typeof entry.optional !== 'boolean'
      || (entry.referenced_preexisting !== undefined && (entry.referenced_preexisting !== true || entry.binding !== 'GUIDE_STATIC'))
      || !Object.hasOwn(R2_PURPOSE_BINDINGS, entry.purpose) || R2_PURPOSE_BINDINGS[entry.purpose] !== entry.binding
      || typeof entry.name !== 'string' || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(entry.name)
      || result[entry.binding] || names.has(entry.name)) throw Error('canonical_r2_purpose_mapping_invalid');
    result[entry.binding] = entry; names.add(entry.name);
  }
  if (!result.MEDIA) throw Error('canonical_r2_media_required');
  return result;
}
/** No generic bucket exemption: each installed binding has one exact purpose/target. */
export function checkPurposeBindings(block, environment) {
  const errors = [], blockers = [];
  let expected;
  try { expected = purposeBuckets(environment); } catch { return { errors: ['canonical_r2_purpose_mapping_invalid'], blockers }; }
  const entries = block.r2_buckets ?? [];
  if (!Array.isArray(entries)) return { errors: ['r2_bindings_invalid'], blockers };
  const seen = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).some(key => !['binding', 'bucket_name', 'preview_bucket_name', 'jurisdiction'].includes(key))
      || !Object.hasOwn(expected, entry.binding) || seen.has(entry.binding)) { errors.push('r2_binding_unknown_or_duplicate'); continue; }
    seen.add(entry.binding);
    const target = expected[entry.binding];
    if (entry.bucket_name !== target.name) {
      if (typeof entry.bucket_name === 'string' && /^(?:replace-|placeholder|0+$)/i.test(entry.bucket_name)) blockers.push(`${entry.binding}:bucket_placeholder`);
      else errors.push(`${entry.binding}:bucket_crossed`);
    }
    if (entry.preview_bucket_name !== undefined && entry.preview_bucket_name !== target.name) errors.push(`${entry.binding}:alternate_store`);
    if (entry.jurisdiction !== undefined) errors.push(`${entry.binding}:unexpected_jurisdiction`);
  }
  if (block.vars?.FREEDOM_PUBLIC_GUIDE_ENABLED !== undefined && !['true', 'false'].includes(block.vars.FREEDOM_PUBLIC_GUIDE_ENABLED)) errors.push('guide_release_flag_invalid');
  if (block.vars?.FREEDOM_PUBLIC_GUIDE_ENABLED === 'true' && !seen.has('GUIDE_STATIC')) errors.push('guide_binding_required');
  return { errors, blockers };
}
