import type { PoolClient } from 'pg';

/** Machine-readable tenant data catalog. Values come from the data-responsibility
 * rows and the installed schema. Retention that has no decision stays undecided.
 */

export type TenantResolution =
  | { readonly kind: 'direct'; readonly column: string }
  | { readonly kind: 'scope'; readonly scope_kind_column: string; readonly scope_id_column: string }
  | { readonly kind: 'asset_purpose'; readonly purposes: readonly string[] }
  | { readonly kind: 'fk_chain'; readonly via: readonly string[] };

export type TableIsolation =
  | { readonly rls: 'enabled'; readonly policies: readonly string[] }
  | { readonly rls: 'exempt'; readonly reason_code: string; readonly reason: string };

export type TableLocation = {
  readonly kind: 'table';
  readonly table: string;
  readonly columns: readonly string[];
  readonly tenant_resolution: TenantResolution;
  readonly isolation: TableIsolation;
};

export type ObjectLocation = {
  readonly kind: 'object';
  readonly purpose: string;
  readonly target_kind: string;
  readonly variants: readonly string[];
};

export type DatasetEntry = {
  readonly dataset_key: string;
  readonly catalog_version: string;
  readonly physical_locations: readonly (TableLocation | ObjectLocation)[];
  readonly classification: string;
  readonly authoritative_module: string;
  readonly tenant_resolution: string;
  readonly identity_keys: readonly string[];
  readonly readable_by: readonly string[];
  readonly writable_by: readonly string[];
  readonly export_scope: string;
  readonly dependency_refs: readonly string[];
  readonly sensitivity: string;
  readonly sharing_purpose: string;
  readonly field_allowlist: readonly string[] | { readonly state: 'undecided'; readonly decision_refs: readonly string[] };
  readonly central_retention: { readonly state: string; readonly decision_refs: readonly string[] } | string;
  readonly derived_copies: readonly unknown[];
  readonly copies_note: string;
  readonly deletion_and_restore: string;
  readonly verification_refs: readonly string[];
};

export type CatalogExemption = {
  readonly table: string;
  readonly dataset_ref: string;
  readonly reason_code: string;
  readonly reason: string;
};

export type TenantDataCatalog = {
  readonly catalog_version: string;
  readonly row_security_force: { readonly state: string; readonly decision_refs: readonly string[]; readonly reason: string };
  readonly exemptions: readonly CatalogExemption[];
  readonly datasets: readonly DatasetEntry[];
};

export type SchemaTable = {
  readonly name: string;
  readonly columns: readonly string[];
  readonly relrowsecurity: boolean;
  readonly relforcerowsecurity: boolean;
  readonly policies: readonly string[];
  readonly tenant_evidence: {
    readonly direct_columns: readonly string[];
    readonly scope_kind_columns: readonly string[];
    readonly asset_purposes: readonly string[];
  };
};

export type TenantSchemaSnapshot = {
  readonly schema: string;
  readonly tables: readonly SchemaTable[];
  readonly detected: readonly string[];
  readonly asset_purposes: readonly string[];
  readonly foreign_keys: readonly { readonly table: string; readonly referenced: string }[];
};

export type CatalogFindingCode =
  | 'unregistered_table'
  | 'unregistered_column'
  | 'stale_location'
  | 'stale_column'
  | 'rls_mismatch'
  | 'policy_mismatch'
  | 'force_rls_set'
  | 'unregistered_asset_purpose'
  | 'tenant_resolution_mismatch'
  | 'retention_unbounded';

export type CatalogFinding = { readonly code: CatalogFindingCode; readonly subject: string };

const UNBOUNDED = new Set(['forever', 'needed', 'analytics']);
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

type SqlToken = string;
type CheckExpression = { kind: 'and' | 'or'; terms: CheckExpression[] } | { kind: 'atom'; tokens: SqlToken[] };

function tokensOf(definition: string): SqlToken[] {
  return definition.match(/'(?:''|[^'])*'|"(?:""|[^"])*"|::|<>|!=|[A-Za-z_][A-Za-z0-9_]*|[^\s]/g) ?? [];
}

/** Remove only parentheses enclosing the whole expression, not an ANY/IN list. */
function unwrapped(tokens: SqlToken[]): SqlToken[] {
  while (tokens[0] === '(' && tokens[tokens.length - 1] === ')') {
    let depth = 0;
    const closesAtEnd = tokens.every((token, index) => {
      if (token === '(') depth++;
      if (token === ')') depth--;
      return depth !== 0 || index === tokens.length - 1;
    });
    if (!closesAtEnd) break;
    tokens = tokens.slice(1, -1);
  }
  return tokens;
}

function splitAt(tokens: SqlToken[], separator: string): SqlToken[][] {
  const groups: SqlToken[][] = [[]];
  let depth = 0;
  for (const token of tokens) {
    if (token === '(' || token === '[') depth++;
    if (token === ')' || token === ']') depth--;
    if (depth === 0 && token.toUpperCase() === separator) groups.push([]);
    else groups[groups.length - 1].push(token);
  }
  return groups;
}

function parseCheck(tokens: SqlToken[]): CheckExpression {
  if (tokens[0]?.toUpperCase() === 'CHECK') tokens = tokens.slice(1);
  tokens = unwrapped(tokens);
  for (const [separator, kind] of [['OR', 'or'], ['AND', 'and']] as const) {
    const groups = splitAt(tokens, separator);
    if (groups.length > 1) return { kind, terms: groups.map(parseCheck) };
  }
  return { kind: 'atom', tokens };
}

function withoutTextCasts(tokens: SqlToken[]): SqlToken[] {
  const result: SqlToken[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '::' && tokens[i + 1]?.toLowerCase() === 'text') {
      i++;
      if (tokens[i + 1] === '[' && tokens[i + 2] === ']') i += 2;
    } else result.push(tokens[i]);
  }
  return result;
}

function literal(token: string | undefined): string | undefined {
  return token?.startsWith("'") && token.endsWith("'") ? token.slice(1, -1).replaceAll("''", "'") : undefined;
}

function valuesOf(tokens: SqlToken[]): string[] | undefined {
  const values: string[] = [];
  for (const group of splitAt(unwrapped(tokens), ',')) {
    const valueTokens = unwrapped(group);
    const value = valueTokens.length === 1 ? literal(valueTokens[0]) : undefined;
    if (value === undefined) return undefined;
    values.push(value);
  }
  return values;
}

/** Undefined means an unsupported expression or a predicate on another column.
 * Such a predicate may allow tenant rows; it cannot safely exclude a table. */
function atomAllows(tokens: SqlToken[], bindings: Readonly<Record<string, string>>): boolean | undefined {
  tokens = unwrapped(withoutTextCasts(tokens));
  let depth = 0;
  const index = tokens.findIndex(token => {
    if (token === '(' || token === '[') depth++;
    if (token === ')' || token === ']') depth--;
    return depth === 0 && ['=', '<>', '!=', 'IN', 'NOT'].includes(token.toUpperCase());
  });
  if (index < 0) return undefined;
  const left = unwrapped(tokens.slice(0, index));
  if (left.length !== 1) return undefined;
  const column = left[0].replace(/^"|"$/g, '');
  if (!Object.hasOwn(bindings, column)) return undefined;
  let operator = tokens[index].toUpperCase();
  let right = unwrapped(tokens.slice(index + 1));
  if (operator === 'NOT' && right[0]?.toUpperCase() === 'IN') {
    operator = 'NOT IN';
    right = unwrapped(right.slice(1));
  }
  let values: string[] | undefined;
  if ((operator === '=' && right[0]?.toUpperCase() === 'ANY')
    || (['<>', '!='].includes(operator) && right[0]?.toUpperCase() === 'ALL')) {
    right = unwrapped(right.slice(1));
    if (right[0]?.toUpperCase() !== 'ARRAY' || right[1] !== '[' || right[right.length - 1] !== ']') return undefined;
    values = valuesOf(right.slice(2, -1));
  } else if (operator === 'IN' || operator === 'NOT IN') {
    values = valuesOf(right);
  } else {
    const value = right.length === 1 ? literal(right[0]) : undefined;
    if (value !== undefined) values = [value];
  }
  if (!values) return undefined;
  const included = values.includes(bindings[column]);
  return ['<>', '!=', 'NOT IN'].includes(operator) ? !included : included;
}

function mayAllow(expression: CheckExpression, bindings: Readonly<Record<string, string>>): boolean {
  if (expression.kind === 'atom') return atomAllows(expression.tokens, bindings) ?? true;
  if (expression.kind === 'and') return expression.terms.every(term => mayAllow(term, bindings));
  return expression.terms.some(term => mayAllow(term, bindings));
}

/** Tenant purposes come only from branches that may admit scope_kind tenant.
 * PostgreSQL deparses IN as = ANY (ARRAY[...]); purpose candidates are evaluated
 * with that scope bound so an adjacent personal/community branch cannot leak in. */
export function tenantPurposesFromConstraint(definition: string): string[] {
  const tokens = tokensOf(definition);
  const expression = parseCheck(tokens);
  const candidates = new Set<string>();
  function visit(term: CheckExpression): void {
    if (term.kind !== 'atom') { term.terms.forEach(visit); return; }
    if (!term.tokens.some(token => token === 'purpose' || token === '"purpose"')) return;
    for (const token of term.tokens) {
      const value = literal(token);
      if (value !== undefined) candidates.add(value);
    }
  }
  visit(expression);
  if (!tokens.some(token => token === 'scope_kind' || token === '"scope_kind"')) return [];
  return [...candidates].filter(purpose => mayAllow(expression, { scope_kind: 'tenant', purpose })).sort();
}

export function admitsTenantScopeKind(definition: string): boolean {
  const tokens = tokensOf(definition);
  if (!tokens.some(token => token === 'scope_kind' || token === '"scope_kind"')) return false;
  return mayAllow(parseCheck(tokens), { scope_kind: 'tenant' });
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const seen = new Set(left);
  return right.every(item => seen.has(item));
}

function tableLocations(catalog: TenantDataCatalog): TableLocation[] {
  return catalog.datasets.flatMap(dataset => dataset.physical_locations.filter((location): location is TableLocation => location.kind === 'table'));
}

function objectPurposes(catalog: TenantDataCatalog): Set<string> {
  return new Set(catalog.datasets.flatMap(dataset => dataset.physical_locations.flatMap(location => location.kind === 'object' ? [location.purpose] : [])));
}

function retentionUnbounded(value: DatasetEntry['central_retention']): boolean {
  if (typeof value === 'string') return UNBOUNDED.has(value);
  return UNBOUNDED.has(value.state);
}

function independentlyTenantBearing(table: SchemaTable): boolean {
  const evidence = table.tenant_evidence;
  return evidence.direct_columns.length > 0 || evidence.scope_kind_columns.length > 0 || evidence.asset_purposes.length > 0;
}

function resolutionMatches(location: TableLocation, tables: ReadonlyMap<string, SchemaTable>, edges: ReadonlySet<string>): boolean {
  const live = tables.get(location.table);
  if (!live) return false;
  const resolution = location.tenant_resolution;
  switch (resolution.kind) {
    case 'direct':
      return live.columns.includes(resolution.column) && live.tenant_evidence.direct_columns.includes(resolution.column);
    case 'scope':
      return live.columns.includes(resolution.scope_kind_column) && live.columns.includes(resolution.scope_id_column)
        && live.tenant_evidence.scope_kind_columns.includes(resolution.scope_kind_column);
    case 'asset_purpose':
      return resolution.purposes.length > 0 && resolution.purposes.every(purpose => live.tenant_evidence.asset_purposes.includes(purpose));
    case 'fk_chain': {
      if (resolution.via.length === 0) return false;
      let prior = location.table;
      for (const next of resolution.via) {
        if (!tables.has(next) || !edges.has(`${prior}/${next}`)) return false;
        prior = next;
      }
      return independentlyTenantBearing(tables.get(prior)!);
    }
  }
}

export function checkTenantCatalog(snapshot: TenantSchemaSnapshot, catalog: TenantDataCatalog): CatalogFinding[] {
  const findings: CatalogFinding[] = [];
  const byName = new Map(snapshot.tables.map(table => [table.name, table]));
  const edges = new Set(snapshot.foreign_keys.map(edge => `${edge.table}/${edge.referenced}`));
  const detected = new Set(snapshot.detected);
  const located = new Map<string, TableLocation>();
  for (const location of tableLocations(catalog)) {
    if (located.has(location.table)) findings.push({ code: 'stale_location', subject: location.table });
    located.set(location.table, location);
  }
  // Catalogued locations stay subject to drift checks even if losing their only
  // tenant edge also removed them from the detector's transitive closure.
  const checked = new Set([...snapshot.detected, ...[...located.keys()].filter(name => byName.has(name))]);
  for (const name of checked) {
    const location = located.get(name);
    const live = byName.get(name);
    if (!location || !live) {
      findings.push({ code: 'unregistered_table', subject: name });
      continue;
    }
    if (!detected.has(name) || !resolutionMatches(location, byName, edges)) findings.push({ code: 'tenant_resolution_mismatch', subject: name });
    const liveColumns = new Set(live.columns);
    const catalogColumns = new Set(location.columns);
    for (const column of live.columns) if (!catalogColumns.has(column)) findings.push({ code: 'unregistered_column', subject: `${name}.${column}` });
    for (const column of location.columns) if (!liveColumns.has(column)) findings.push({ code: 'stale_column', subject: `${name}.${column}` });
    if (live.relforcerowsecurity) findings.push({ code: 'force_rls_set', subject: name });
    if (location.isolation.rls === 'enabled') {
      if (!live.relrowsecurity) findings.push({ code: 'rls_mismatch', subject: name });
      if (!sameSet(location.isolation.policies, live.policies)) findings.push({ code: 'policy_mismatch', subject: name });
    } else {
      if (live.relrowsecurity) findings.push({ code: 'rls_mismatch', subject: name });
      if (live.policies.length > 0) findings.push({ code: 'policy_mismatch', subject: name });
    }
  }
  for (const location of located.values()) {
    if (!byName.has(location.table)) findings.push({ code: 'stale_location', subject: location.table });
  }
  for (const purpose of snapshot.asset_purposes) {
    if (!objectPurposes(catalog).has(purpose)) findings.push({ code: 'unregistered_asset_purpose', subject: purpose });
  }
  for (const dataset of catalog.datasets) {
    if (retentionUnbounded(dataset.central_retention)) findings.push({ code: 'retention_unbounded', subject: dataset.dataset_key });
  }
  return findings.sort((left, right) => left.code < right.code ? -1 : left.code > right.code ? 1 : left.subject < right.subject ? -1 : left.subject > right.subject ? 1 : 0);
}

type RawTable = {
  name: string; columns: string[]; relrowsecurity: boolean; relforcerowsecurity: boolean; policies: string[];
  tenant_evidence: { direct_columns: string[]; scope_kind_columns: string[]; asset_purposes: string[] };
};

export async function introspectTenantSchema(q: PoolClient, schema: string): Promise<TenantSchemaSnapshot> {
  if (!IDENT.test(schema)) throw new Error('tenant_schema_invalid');
  const relations = (await q.query<{ name: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
    `SELECT c.relname AS name, c.relrowsecurity, c.relforcerowsecurity
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind = 'r'
      ORDER BY c.relname`, [schema])).rows;
  const columns = (await q.query<{ table: string; column: string }>(
    `SELECT c.relname AS table, a.attname AS column
       FROM pg_catalog.pg_attribute a
       JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY c.relname, a.attnum`, [schema])).rows;
  const policies = (await q.query<{ table: string; name: string }>(
    `SELECT c.relname AS table, p.polname AS name
       FROM pg_catalog.pg_policy p
       JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
      ORDER BY c.relname, p.polname`, [schema])).rows;
  const foreignKeys = (await q.query<{ table: string; referenced: string }>(
    `SELECT src.relname AS table, dst.relname AS referenced
       FROM pg_catalog.pg_constraint co
       JOIN pg_catalog.pg_class src ON src.oid = co.conrelid
       JOIN pg_catalog.pg_namespace ns ON ns.oid = src.relnamespace
       JOIN pg_catalog.pg_class dst ON dst.oid = co.confrelid
       JOIN pg_catalog.pg_namespace nd ON nd.oid = dst.relnamespace
      WHERE co.contype = 'f' AND ns.nspname = $1 AND nd.nspname = $1 AND src.relkind = 'r'
      ORDER BY src.relname, dst.relname`, [schema])).rows;
  const checks = (await q.query<{ table: string; name: string; definition: string }>(
    `SELECT c.relname AS table, co.conname AS name, pg_catalog.pg_get_constraintdef(co.oid) AS definition
       FROM pg_catalog.pg_constraint co
       JOIN pg_catalog.pg_class c ON c.oid = co.conrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE co.contype = 'c' AND n.nspname = $1 AND c.relkind = 'r'`, [schema])).rows;

  const tables = new Map<string, RawTable>();
  for (const relation of relations) {
    tables.set(relation.name, {
      name: relation.name,
      columns: [],
      relrowsecurity: relation.relrowsecurity,
      relforcerowsecurity: relation.relforcerowsecurity,
      policies: [],
      tenant_evidence: { direct_columns: [], scope_kind_columns: [], asset_purposes: [] },
    });
  }
  for (const column of columns) tables.get(column.table)?.columns.push(column.column);
  for (const policy of policies) tables.get(policy.table)?.policies.push(policy.name);

  const detected = new Set<string>();
  for (const table of tables.values()) {
    table.tenant_evidence.direct_columns.push(...table.columns.filter(column => column === 'tenant_id' || column === 'tenant_ref' || column.endsWith('_tenant_id')));
    if (table.tenant_evidence.direct_columns.length > 0) detected.add(table.name);
  }
  const scopeKindTables = new Set<string>();
  for (const check of checks) {
    if (admitsTenantScopeKind(check.definition) && tables.get(check.table)?.columns.includes('scope_kind')) scopeKindTables.add(check.table);
  }
  for (const name of scopeKindTables) {
    detected.add(name);
    tables.get(name)!.tenant_evidence.scope_kind_columns.push('scope_kind');
  }

  const purposes = new Set<string>();
  for (const check of checks) {
    if (check.name !== 'asset_scope_purpose') continue;
    for (const purpose of tenantPurposesFromConstraint(check.definition)) purposes.add(purpose);
  }
  if (purposes.size > 0 && tables.has('asset_objects')) {
    detected.add('asset_objects');
    tables.get('asset_objects')!.tenant_evidence.asset_purposes.push(...[...purposes].sort());
  }

  let grew = true;
  while (grew) {
    grew = false;
    for (const key of foreignKeys) {
      if (detected.has(key.referenced) && tables.has(key.table) && !detected.has(key.table)) {
        detected.add(key.table);
        grew = true;
      }
    }
  }

  return {
    schema,
    tables: [...tables.values()].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
    detected: [...detected].sort(),
    asset_purposes: [...purposes].sort(),
    foreign_keys: foreignKeys,
  };
}

const TRANSACTION_IMPORT = /import\s+(?:type\s+)?\{[^}]*\btransaction\b[^}]*\}\s+from\s+['"][^'"]*(?:packages\/db|\/transaction\.js)['"]/;
const POOL_QUERY = /\bpool\.query\s*\(/;

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"/])\/\/[^\n]*/g, '$1');
}

/** Static guard: tenant modules must not import the legacy transaction helper or call pool.query. */
export function tenantIsolationImportFindings(files: readonly { path: string; source: string }[]): { path: string; kind: 'db_transaction_import' | 'pool_query' }[] {
  const findings: { path: string; kind: 'db_transaction_import' | 'pool_query' }[] = [];
  for (const file of files) {
    const source = withoutComments(file.source);
    if (TRANSACTION_IMPORT.test(source)) findings.push({ path: file.path, kind: 'db_transaction_import' });
    if (POOL_QUERY.test(source)) findings.push({ path: file.path, kind: 'pool_query' });
  }
  return findings.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : left.kind < right.kind ? -1 : 1);
}
