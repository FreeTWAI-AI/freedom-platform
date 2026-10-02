// Read-only, deliberately incomplete source audit. This module never imports,
// compiles or executes candidate code. The parser and immutable reader are HOST
// ports; neither may be resolved from the candidate dependency installation.
import { artifactPath, parseJson, sha256 } from './io.mjs';
import { validateDescriptor, isModuleDescriptorPath } from './context.mjs';

const ROOT = 'apps/platform-api/src/platform-app.ts';
const PROFILE = 'platform-member-routes/v1';
const ROUTES = [
  { entry: 'apps/platform-api/src/routes/avatars.ts', factory: 'createAvatarRoutes', module: 'assets', surface: 'member.avatar',
    import: './routes/avatars.js', routes: [['get', '/me/avatar', 'member.avatar.metadata'], ['post', '/me/avatar', 'member.avatar.replace'],
      ['post', '/me/avatar/remove', 'member.avatar.remove'], ['get', '/members/:id/avatar', 'member.avatar.read']], middleware: [] },
  { entry: 'apps/platform-api/src/routes/private-work.ts', factory: 'createPrivateWorkRoutes', module: 'work', surface: 'work.private-read-api',
    import: './routes/private-work.js', routes: [['get', '/me/private-work', 'work.private.list'], ['get', '/me/private-work/:id', 'work.private.read']],
    middleware: ['/me/private-work*'] },
];
const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all', 'on', 'route', 'use']);
const uniq = xs => [...new Set(xs)].sort();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const digest = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x) && x.length === 64;

/**
 * snapshots: {baseline:{paths,read},candidate:{paths,read}}. paths and read are
 * host-owned immutable tree readers; read returns bytes, never modules/ASTs.
 * parser: {api,version,installationSha256}; approvedParser:{version,installationSha256}
 * are independent HOST installation inputs, not candidate assertions or proof.
 * No default parser lookup, dynamic import, filesystem traversal or test runner.
 */
export function auditSurfaceRegistrations({ baseline, candidate, changedPaths = [], profile = PROFILE }, { parser, approvedParser } = {}) {
  const issues = [], evidence = [], registrations = [], declarations = [], modules = [];
  const add = (revision, entry, code, status = 'unavailable') => issues.push({ revision, entry, code, status });
  const output = () => ({ format: 'freedom.surface-audit/v1', assurance_level: 'local', profile,
    status: issues.some(x => x.status === 'failed') ? 'failed' : 'unavailable',
    registration_status: issues.some(x => x.status === 'failed') ? 'failed'
      : issues.some(x => !['registration_behavior_audit_required', 'surface_unmapped'].includes(x.code)) ? 'unavailable' : 'passed',
    behavior_checked: false, execution_authorized: false, merge_authorized: false,
    parser: parser && approvedParser ? { version: approvedParser.version, installation_sha256: approvedParser.installationSha256,
      provenance: 'host-supplied-not-authenticated-by-this-audit' } : null,
    evidence, registrations, issues,
    surface_ids: uniq(declarations.map(x => x.surface_id)), operation_ids: uniq(declarations.flatMap(x => x.operations)),
    module_ids: uniq(modules.map(x => x.module_id)), required_tests: uniq(modules.flatMap(x => x.tests)),
    blockers: uniq(issues.map(x => x.code)) });
  add('both', ROOT, 'registration_behavior_audit_required');
  const profileReady = profile === PROFILE;
  if (!profileReady) add('both', '', 'surface_profile_unsupported');
  const ts = parser?.api;
  const parserReady = !(!ts || typeof ts.createSourceFile !== 'function' || typeof ts.forEachChild !== 'function'
    || !ts.ScriptTarget || !ts.ScriptKind || !approvedParser || typeof approvedParser.version !== 'string' || !digest(approvedParser.installationSha256)
    || parser.version !== approvedParser.version || ts.version !== parser.version || parser.installationSha256 !== approvedParser.installationSha256);
  if (!parserReady) add('both', '', 'trusted_parser_unavailable');
  let totalBytes = 0;
  function source(reader, paths, path, revision) {
    if (!paths.has(path)) { add(revision, path, 'registration_source_missing', 'failed'); return null; }
    try {
      const input = reader.read(path);
      if (!(input instanceof Uint8Array) || input.byteLength > 128_000 || (totalBytes += input.byteLength) > 2_000_000) throw 0;
      const bytes = Uint8Array.from(input), text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      evidence.push({ revision, path, bytes: bytes.length, sha256: sha256(bytes) });
      return { bytes, text };
    } catch { add(revision, path, 'surface_source_unavailable'); return null; }
  }
  function parse(text, path, revision) {
    try {
      const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      if (file.parseDiagnostics.length) throw 0;
      const nodes = [], stack = [[file, 0]];
      while (stack.length) {
        const [node, depth] = stack.pop();
        if (depth > 128 || nodes.length >= 30_000) throw 0;
        nodes.push(node); ts.forEachChild(node, child => { stack.push([child, depth + 1]); });
      }
      return { file, nodes };
    } catch { add(revision, path, 'surface_syntax_unavailable'); return null; }
  }
  const ident = (node, name) => !!node && ts.isIdentifier(node) && node.text === name;
  const literal = node => node && ts.isStringLiteral(node) ? node.text : null;
  const exported = node => node.modifiers?.some(x => x.kind === ts.SyntaxKind.ExportKeyword);
  const member = (node, object, name) => node && ts.isPropertyAccessExpression(node) && !node.questionDotToken
    && ident(node.expression, object) && (!name || node.name.text === name);
  const statementCall = (node, body) => ts.isExpressionStatement(node.parent) && node.parent.parent === body;
  function avatarSetup(declaration) {
    const call = declaration.initializer;
    if (!ident(declaration.name, 'uploadAvatar') || !call || !ts.isCallExpression(call) || !ident(call.expression, 'createAvatarUploadFacade')
      || call.questionDotToken || call.arguments.length !== 2 || !ident(call.arguments[0], 'pool')) return false;
    const object = call.arguments[1];
    if (!ts.isObjectLiteralExpression(object) || object.properties.length !== 2) return false;
    const store = object.properties[0], save = object.properties[1];
    if (!ts.isShorthandPropertyAssignment(store) || !ident(store.name, 'store') || store.objectAssignmentInitializer
      || !ts.isPropertyAssignment(save) || !ident(save.name, 'legacySave') || !ts.isArrowFunction(save.initializer)) return false;
    const fn = save.initializer, body = fn.body;
    return fn.parameters.length === 2 && fn.parameters.every((x, i) => ident(x.name, ['input', 'upload'][i]) && !x.initializer && !x.dotDotDotToken)
      && ts.isCallExpression(body) && ident(body.expression, 'saveAvatar') && !body.questionDotToken && body.arguments.length === 3
      && body.arguments.every((x, i) => ident(x, ['pool', 'input', 'upload'][i]));
  }
  function finalReturn(ast, selected, path, revision) {
    const last = selected.fn.body.statements.at(-1);
    if (!last || !ts.isReturnStatement(last) || !ident(last.expression, 'app')
      || selected.fn.body.statements.filter(x => ts.isReturnStatement(x)).length !== 1) add(revision, path, 'registration_return_unsupported');
  }
  function factory(ast, name, path, revision) {
    const values = ast.file.statements.filter(x => ts.isFunctionDeclaration(x) && ident(x.name, name) && exported(x) && x.body);
    if (values.length !== 1) { add(revision, path, 'registration_factory_missing', 'failed'); return null; }
    const fn = values[0], apps = ast.nodes.filter(x => ts.isVariableDeclaration(x) && ident(x.name, 'app'));
    if (fn.asteriskToken || fn.modifiers.some(x => x.kind !== ts.SyntaxKind.ExportKeyword)) {
      add(revision, path, 'registration_factory_grammar_unsupported'); return null;
    }
    const app = apps[0], ctor = app?.initializer;
    if (apps.length !== 1 || !app || app.parent.parent.parent !== fn.body || !(app.parent.flags & ts.NodeFlags.Const)
      || !ctor || !ts.isNewExpression(ctor) || !ident(ctor.expression, 'Hono') || (ctor.arguments?.length ?? 0) !== 0) {
      add(revision, path, 'registration_receiver_unsupported'); return null;
    }
    return { fn, app, ctor };
  }
  function honoImport(ast, expected, path, revision) {
    const uses = ast.nodes.filter(x => ident(x, 'Hono'));
    const imports = uses.filter(x => ts.isImportSpecifier(x.parent) && x.parent.name === x && !x.parent.propertyName
      && !x.parent.isTypeOnly && !x.parent.parent.parent.isTypeOnly
      && literal(x.parent.parent.parent.parent.moduleSpecifier) === 'hono');
    if (imports.length !== 1 || uses.some(x => x !== imports[0] && x !== expected.ctor.expression)) add(revision, path, 'registration_constructor_unsupported');
  }
  function inspectLeaf(ast, p, revision) {
    const selected = factory(ast, p.factory, p.entry, revision);
    if (!selected) return;
    honoImport(ast, selected, p.entry, revision);
    if (ast.file.statements.some(x => !ts.isImportDeclaration(x) && !ts.isFunctionDeclaration(x))) add(revision, p.entry, 'registration_module_grammar_unsupported');
    const allowed = new Set([selected.app.name]), seen = [], uses = [];
    for (const node of ast.nodes) {
      if (ts.isReturnStatement(node) && ident(node.expression, 'app') && node.parent === selected.fn.body) allowed.add(node.expression);
      if (!ts.isCallExpression(node) || !member(node.expression, 'app')) continue;
      const method = node.expression.name.text, path = literal(node.arguments[0]);
      const handler = node.arguments[1];
      if (!statementCall(node, selected.fn.body) || node.questionDotToken || node.arguments.length !== 2
        || !path || !handler || !ts.isArrowFunction(handler)) { add(revision, p.entry, 'dynamic_registration_unsupported'); continue; }
      allowed.add(node.expression.expression);
      if (method === 'use') { uses.push(path); continue; }
      const mapping = p.routes.find(x => x[0] === method && x[1] === path);
      if (!mapping) { add(revision, p.entry, 'undeclared_registration', 'failed'); continue; }
      seen.push(mapping[2]);
      registrations.push({ revision, entry: p.entry, surface_id: p.surface, operation_id: mapping[2],
        method: method.toUpperCase(), path: '/api/v1' + path, line: ast.file.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
    }
    if (ast.nodes.some(x => ident(x, 'app') && !allowed.has(x))) add(revision, p.entry, 'registration_receiver_escape');
    let setups = 0;
    for (const statement of selected.fn.body.statements) {
      if (ts.isVariableStatement(statement) && (statement.declarationList.flags & ts.NodeFlags.Const)
        && statement.declarationList.declarations.length === 1) {
        const declaration = statement.declarationList.declarations[0];
        if (declaration === selected.app) continue;
        if (p.factory === 'createAvatarRoutes' && avatarSetup(declaration) && ++setups === 1) continue;
      }
      if (ts.isReturnStatement(statement) && ident(statement.expression, 'app')) continue;
      if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)
        && member(statement.expression.expression, 'app')) continue;
      add(revision, p.entry, 'registration_factory_grammar_unsupported');
    }
    finalReturn(ast, selected, p.entry, revision);
    if (!same(uses.sort(), [...p.middleware].sort())) add(revision, p.entry, 'registration_middleware_changed');
    for (const [, , op] of p.routes) {
      const count = seen.filter(x => x === op).length;
      if (count !== 1) add(revision, p.entry, count ? 'duplicate_registration' : 'registration_operation_missing', 'failed');
    }
  }
  function inspectMount(ast, p, rootFactory, revision) {
    const refs = ast.nodes.filter(x => ident(x, p.factory)), permitted = new Set(); let mounts = 0;
    for (const ref of refs) {
      const node = ref.parent;
      if (ts.isImportSpecifier(node) && node.name === ref && !node.propertyName && !node.isTypeOnly
        && !node.parent.parent.isTypeOnly && literal(node.parent.parent.parent.moduleSpecifier) === p.import) { permitted.add(ref); continue; }
      if (!ts.isCallExpression(node) || node.expression !== ref) continue;
      const mount = node.parent;
      if (!ts.isCallExpression(mount) || !member(mount.expression, 'app', 'route') || node.questionDotToken || mount.questionDotToken
        || mount.arguments.length !== 2 || mount.arguments[1] !== node || literal(mount.arguments[0]) !== '/api/v1'
        || !statementCall(mount, rootFactory.fn.body)) continue;
      permitted.add(ref); mounts++;
    }
    const imports = refs.filter(x => ts.isImportSpecifier(x.parent) && permitted.has(x));
    if (mounts !== 1 || imports.length !== 1) add(revision, ROOT, 'registration_mount_missing_or_changed', 'failed');
    if (refs.some(x => !permitted.has(x))) add(revision, ROOT, 'registration_factory_escape');
  }
  function inspectRootReceiver(ast, selected, revision) {
    finalReturn(ast, selected, ROOT, revision);
    const final = selected.fn.body.statements.at(-1);
    for (const statement of selected.fn.body.statements) {
      if (ts.isVariableStatement(statement) || ts.isExpressionStatement(statement) || ts.isForOfStatement(statement) || statement === final) continue;
      add(revision, ROOT, 'registration_root_grammar_unsupported');
    }
    // Return/throw in an executing root block/loop is not a handler return.
    for (const node of ast.nodes) if ((ts.isReturnStatement(node) || ts.isThrowStatement(node)) && node !== final) {
      let owner = node.parent;
      while (owner && !ts.isFunctionLike(owner)) owner = owner.parent;
      if (owner === selected.fn) add(revision, ROOT, 'registration_root_grammar_unsupported');
    }
    for (const ref of ast.nodes.filter(x => ident(x, 'app'))) {
      if (ref === selected.app.name || (ts.isReturnStatement(final) && ref === final.expression)) continue;
      const parent = ref.parent;
      if (member(parent, 'app') && ts.isCallExpression(parent.parent) && parent.parent.expression === parent
        && !parent.parent.questionDotToken && (METHODS.has(parent.name.text) || parent.name.text === 'onError')) continue;
      // Existing aggregate delegate helpers are explicitly NOT audited. Allowing
      // these references avoids claiming the whole root is a closed grammar;
      // the mandatory aggregate surface_unmapped/behavior blockers remain.
      if (ts.isCallExpression(parent) && parent.arguments[0] === ref && !parent.questionDotToken
        && ['registerMemberPromotion', 'registerMemberServices', 'registerPublicPromotion', 'registerPublicMemberServices'].some(name => ident(parent.expression, name))
        && statementCall(parent, selected.fn.body)) continue;
      add(revision, ROOT, 'registration_receiver_escape');
    }
  }
  for (const [revision, reader] of [['baseline', baseline], ['candidate', candidate]]) {
    if (!reader || !Array.isArray(reader.paths) || reader.paths.length > 8192 || typeof reader.read !== 'function') {
      add(revision, '', 'surface_reader_unavailable'); continue;
    }
    let paths;
    try {
      const names = reader.paths.map(artifactPath);
      if (new Set(names.map(x => x.toLowerCase())).size !== names.length) throw 0;
      paths = new Set(names);
    } catch { add(revision, '', 'surface_paths_invalid'); continue; }
    const descriptors = [], descriptorPaths = [...paths].filter(isModuleDescriptorPath);
    if (!descriptorPaths.length || descriptorPaths.length > 256) { add(revision, '', 'surface_descriptors_unavailable'); continue; }
    for (const path of descriptorPaths) {
      const data = source(reader, paths, path, revision);
      if (!data) continue;
      try {
        const value = validateDescriptor(parseJson(data.bytes)); descriptors.push(value); modules.push({ ...value, revision });
        for (const surface of value.surfaces) {
          declarations.push({ ...surface, revision, module_id: value.module_id, tests: value.tests });
          if (!paths.has(surface.entry)) add(revision, surface.entry, 'surface_declaration_entry_missing', 'failed');
        }
      } catch { add(revision, path, 'surface_descriptor_invalid', 'failed'); }
    }
    if (new Set(descriptors.map(x => x.module_id)).size !== descriptors.length) add(revision, '', 'duplicate_module', 'failed');
    if (!profileReady || !parserReady) {
      for (const item of declarations.filter(x => x.revision === revision)) add(revision, item.entry, 'surface_unmapped');
      continue;
    }
    for (const p of ROUTES) {
      const declared = declarations.filter(x => x.revision === revision && (x.surface_id === p.surface || x.entry === p.entry));
      if (declared.length !== 1 || declared[0].surface_id !== p.surface || declared[0].module_id !== p.module
        || declared[0].entry !== p.entry || declared[0].kind !== 'http' || declared[0].auth_profile !== 'member-session'
        || !same([...declared[0].operations].sort(), p.routes.map(x => x[2]).sort())) add(revision, p.entry, 'registration_declaration_mismatch', 'failed');
      const data = source(reader, paths, p.entry, revision), ast = data && parse(data.text, p.entry, revision);
      if (ast) inspectLeaf(ast, p, revision);
    }
    const data = source(reader, paths, ROOT, revision), ast = data && parse(data.text, ROOT, revision);
    if (ast) {
      const rootFactory = factory(ast, 'createPlatformApp', ROOT, revision);
      if (rootFactory) {
        honoImport(ast, rootFactory, ROOT, revision);
        inspectRootReceiver(ast, rootFactory, revision);
        for (const p of ROUTES) inspectMount(ast, p, rootFactory, revision);
        for (const node of ast.nodes) if (ts.isCallExpression(node) && member(node.expression, 'app') && METHODS.has(node.expression.name.text)) {
          const path = literal(node.arguments[0]), method = node.expression.name.text;
          if (ROUTES.some(p => p.routes.some(x => x[0] === method && '/api/v1' + x[1] === path))) add(revision, ROOT, 'registration_outside_profile', 'failed');
        }
      }
      // Root has other factories, delegate helpers, dynamic loops and middleware.
      // Never infer their absence or behavior from this limited leaf proof.
      add(revision, ROOT, 'surface_unmapped');
    }
    for (const item of declarations.filter(x => x.revision === revision)) {
      if (!ROUTES.some(p => p.surface === item.surface_id && p.entry === item.entry)) add(revision, item.entry, 'surface_unmapped');
    }
  }
  // A candidate cannot approve its own descriptor, new entry or reduced suite set.
  const before = declarations.filter(x => x.revision === 'baseline'), after = declarations.filter(x => x.revision === 'candidate');
  const identity = ({ revision, ...x }) => JSON.stringify({ ...x, operations: [...x.operations].sort(), tests: [...x.tests].sort() });
  if (!same(before.map(identity).sort(), after.map(identity).sort())) add('both', '', 'surface_baseline_review_required');
  try {
    if (!Array.isArray(changedPaths) || changedPaths.length > 8192) throw 0;
    for (const path of changedPaths) {
      artifactPath(path);
      if (!ROUTES.some(p => p.entry === path) && !isModuleDescriptorPath(path)) add('both', path, 'surface_unmapped');
    }
  } catch { add('both', '', 'surface_changed_paths_invalid'); }
  return output();
}
