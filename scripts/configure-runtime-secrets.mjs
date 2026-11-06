/* global fetch, AbortSignal */
import { randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, chmod, rm, stat, appendFile } from 'node:fs/promises';
import { resolve, join, sep, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

export class RuntimeConfigurationError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new RuntimeConfigurationError(code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, name) => Object.hasOwn(value, name);
const strong = value => typeof value === 'string' && Buffer.byteLength(value, 'utf8') >= 32 && value.trim() === value && !/[\r\n\0]/.test(value);
const opaque = value => typeof value === 'string' && value.length > 0 && value.trim() === value && !/[\r\n\0]/.test(value);
const secretId = value => typeof value === 'string' && /^[A-Za-z0-9/_+=.@:-]{1,2048}$/.test(value);
const arn = value => typeof value === 'string' && /^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]+$/.test(value);

function json(text) {
  try { const value = JSON.parse(text); if (!object(value)) fail('INVALID_SECRET_JSON'); return value; }
  catch { fail('INVALID_SECRET_JSON'); }
}

function awsExecutor(env) {
  const execute = promisify(execFile);
  return async args => {
    const result = await execute('aws', args, { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true, env: { ...env, AWS_PAGER: '', AWS_CLI_AUTO_PROMPT: 'off', AWS_CLI_FILE_ENCODING: 'UTF-8' } });
    return result.stdout;
  };
}

export async function configureRuntimeSecrets({ env, runAws, request = fetch, random = randomBytes }) {
  if (env?.GITHUB_ACTIONS !== 'true' || typeof runAws !== 'function') fail('ACTIONS_ONLY');
  if (!['os', 'production', 'billing'].includes(env.RUNTIME_COMPONENT)) fail('INVALID_COMPONENT');
  if (!/^[a-z0-9-]+$/.test(env.AWS_REGION ?? '')) fail('AWS_REGION_REQUIRED');
  if (env.BILLING_BOOTSTRAP && !['true', 'false'].includes(env.BILLING_BOOTSTRAP)) fail('INVALID_BOOTSTRAP_MODE');
  if (!env.RUNNER_TEMP) fail('RUNNER_TEMP_REQUIRED');
  const runnerTemp = resolve(env.RUNNER_TEMP);
  if (!(await stat(runnerTemp).catch(() => null))?.isDirectory()) fail('RUNNER_TEMP_REQUIRED');
  const ids = {
    jwt: env.JWT_SECRET_ID || 'oficina/fase4/jwt',
    internal: env.AUTH_CLIENT_LOOKUP_SECRET_ID || 'oficina/fase4/auth-client-lookup',
    os: env.OS_RUNTIME_SECRET_ID || 'oficina/fase4/os/homolog/runtime',
    production: env.PRODUCTION_RUNTIME_SECRET_ID || 'oficina/homolog/production/application',
    billing: env.BILLING_RUNTIME_SECRET_ID || 'oficina/homolog/billing/runtime',
  };
  const relevant = ['jwt', 'internal', env.RUNTIME_COMPONENT];
  if (relevant.some(name => !secretId(ids[name])) || new Set(relevant.map(name => ids[name])).size !== relevant.length) fail('INVALID_SECRET_IDS');
  const common = ['--region', env.AWS_REGION, '--no-cli-pager', 'secretsmanager'];
  let privateRoot;
  const changed = [];
  async function readSecret(name) {
    let metadata;
    try { metadata = json(await runAws([...common, 'describe-secret', '--secret-id', ids[name], '--output', 'json'])); }
    catch (error) {
      if (/\(ResourceNotFoundException\)/.test(String(error?.stderr ?? ''))) return { name, exists: false, value: undefined };
      if (error instanceof RuntimeConfigurationError) throw error;
      fail('AWS_SECRET_READ_FAILED');
    }
    if (!arn(metadata.ARN)) fail('INVALID_AWS_METADATA');
    if (metadata.DeletedDate) fail('SECRET_PENDING_DELETION');
    const versions = metadata.VersionIdsToStages ?? {};
    if (!object(versions)) fail('INVALID_AWS_METADATA');
    if (!Object.values(versions).some(stages => Array.isArray(stages) && stages.includes('AWSCURRENT'))) {
      if (Object.keys(versions).length > 0) fail('SECRET_CURRENT_VERSION_MISSING');
      return { name, exists: true, arn: metadata.ARN, value: undefined };
    }
    let text;
    try { text = await runAws([...common, 'get-secret-value', '--secret-id', ids[name], '--version-stage', 'AWSCURRENT', '--query', 'SecretString', '--output', 'text']); }
    catch { fail('AWS_SECRET_READ_FAILED'); }
    return { name, exists: true, arn: metadata.ARN, value: json(text) };
  }
  async function save(snapshot, value) {
    if (!privateRoot) { privateRoot = await mkdtemp(join(runnerTemp, 'oficina-runtime-')); await chmod(privateRoot, 0o700); }
    const file = join(privateRoot, `${snapshot.name}.json`);
    await writeFile(file, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    let response;
    try {
      const operation = snapshot.exists ? ['put-secret-value', '--secret-id', ids[snapshot.name]] : ['create-secret', '--name', ids[snapshot.name]];
      if (!snapshot.exists && ids[snapshot.name].startsWith('arn:')) fail('CANNOT_CREATE_MISSING_SECRET_ARN');
      response = json(await runAws([...common, ...operation, '--secret-string', `file://${file}`, '--output', 'json']));
    } catch (error) { if (error instanceof RuntimeConfigurationError) throw error; fail('AWS_SECRET_WRITE_FAILED'); }
    finally { await rm(file, { force: true }); }
    if (!arn(response.ARN)) fail('INVALID_AWS_METADATA');
    changed.push(snapshot.name);
    return { ...snapshot, exists: true, arn: response.ARN, value };
  }
  function validateJwt(value) {
    if (!object(value) || !strong(value.secret) || !strong(value.refreshSecret) || value.secret === value.refreshSecret) fail('INVALID_SHARED_JWT');
  }
  function validateInternal(value) { if (!object(value) || !strong(value.token)) fail('INVALID_SHARED_INTERNAL_TOKEN'); }
  function validateRuntime(value, token) {
    if (!object(value) || !strong(value.AUTH_CLIENT_LOOKUP_TOKEN)) fail('INVALID_RUNTIME_INTERNAL_TOKEN');
    if (value.AUTH_CLIENT_LOOKUP_TOKEN !== token) fail('INTERNAL_TOKEN_MISMATCH');
  }
  function newKey() { const value = random(48).toString('base64url'); if (!strong(value)) fail('INVALID_RANDOM_SOURCE'); return value; }

  try {
    let jwt = await readSecret('jwt');
    let internal = await readSecret('internal');
    let runtime = await readSecret(env.RUNTIME_COMPONENT);
    if (env.RUNTIME_COMPONENT === 'production' && !runtime.exists) fail('PRODUCTION_METADATA_MUST_EXIST');
    if (jwt.value !== undefined) validateJwt(jwt.value);
    if (internal.value !== undefined) validateInternal(internal.value);
    if (env.RUNTIME_COMPONENT !== 'os' && (jwt.value === undefined || internal.value === undefined)) fail('SHARED_SECRETS_MUST_EXIST');
    const jwtValue = jwt.value ?? { secret: newKey(), refreshSecret: newKey() };
    validateJwt(jwtValue);
    // An existing valid OS token can initialize its missing canonical lookup secret.
    if (runtime.value !== undefined && env.RUNTIME_COMPONENT === 'os' && !strong(runtime.value.AUTH_CLIENT_LOOKUP_TOKEN)) fail('INVALID_RUNTIME_INTERNAL_TOKEN');
    const internalValue = internal.value ?? { token: runtime.value?.AUTH_CLIENT_LOOKUP_TOKEN ?? newKey() };
    validateInternal(internalValue);
    const token = internalValue.token;
    if (runtime.value !== undefined) validateRuntime(runtime.value, token);
    let desired;
    if (env.RUNTIME_COMPONENT === 'os') {
      if (runtime.value !== undefined && own(runtime.value, 'ADMIN_SEED_PASSWORD') && !strong(runtime.value.ADMIN_SEED_PASSWORD)) fail('INVALID_ADMIN_SEED_PASSWORD');
      desired = runtime.value ?? { AUTH_CLIENT_LOOKUP_TOKEN: token };
      if (!own(desired, 'ADMIN_SEED_PASSWORD')) desired = { ...desired, ADMIN_SEED_PASSWORD: newKey() };
    } else if (env.RUNTIME_COMPONENT === 'production') {
      if (runtime.value !== undefined && (!strong(runtime.value.JWT_SECRET) || runtime.value.JWT_SECRET !== jwtValue.secret)) fail('RUNTIME_JWT_MISMATCH');
      desired = runtime.value ?? { JWT_SECRET: jwtValue.secret, AUTH_CLIENT_LOOKUP_TOKEN: token };
    } else {
      const bootstrap = env.BILLING_BOOTSTRAP === 'true';
      const current = runtime.value ?? { AUTH_CLIENT_LOOKUP_TOKEN: token };
      const hasAccess = own(current, 'MP_ACCESS_TOKEN'); const hasWebhook = own(current, 'MP_WEBHOOK_SECRET');
      if (bootstrap) {
        if (hasAccess || hasWebhook) fail('BILLING_ALREADY_HAS_PAYMENT_CREDENTIALS');
        desired = current;
      } else {
        if (!opaque(env.MP_ACCESS_TOKEN) || !opaque(env.MP_WEBHOOK_SECRET)) fail('MERCADO_PAGO_PAIR_REQUIRED');
        if (hasAccess !== hasWebhook || hasAccess && (!opaque(current.MP_ACCESS_TOKEN) || !opaque(current.MP_WEBHOOK_SECRET))) fail('INVALID_STORED_MERCADO_PAGO_PAIR');
        if (hasAccess && (current.MP_ACCESS_TOKEN !== env.MP_ACCESS_TOKEN || current.MP_WEBHOOK_SECRET !== env.MP_WEBHOOK_SECRET)) fail('MERCADO_PAGO_ROTATION_REQUIRES_REVIEW');
        let seller;
        try {
          const response = await request('https://api.mercadopago.com/users/me', { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10000), headers: { Authorization: `Bearer ${env.MP_ACCESS_TOKEN}`, Accept: 'application/json' } });
          if (!response.ok) fail('MERCADO_PAGO_VERIFICATION_FAILED');
          seller = await response.json();
        } catch { fail('MERCADO_PAGO_VERIFICATION_FAILED'); }
        if (!object(seller) || seller.site_id !== 'MLB' || !Array.isArray(seller.tags) || !seller.tags.includes('test_user')) fail('MERCADO_PAGO_TEST_SELLER_REQUIRED');
        desired = hasAccess ? current : { ...current, MP_ACCESS_TOKEN: env.MP_ACCESS_TOKEN, MP_WEBHOOK_SECRET: env.MP_WEBHOOK_SECRET };
      }
    }
    // Validation finishes before the first write. Never replace an existing key.
    if (jwt.value === undefined) jwt = await save(jwt, jwtValue);
    if (internal.value === undefined) internal = await save(internal, internalValue);
    if (runtime.value === undefined || JSON.stringify(runtime.value) !== JSON.stringify(desired)) runtime = await save(runtime, desired);
    return { component: env.RUNTIME_COMPONENT, changed, secretArns: { jwt: jwt.arn, internal: internal.arn, [env.RUNTIME_COMPONENT]: runtime.arn } };
  } finally {
    if (privateRoot) {
      const target = resolve(privateRoot);
      if (!target.startsWith(runnerTemp + sep) || !/^oficina-runtime-[A-Za-z0-9_-]{6,}$/.test(basename(target))) fail('UNSAFE_TEMP_CLEANUP');
      await rm(target, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.env.GITHUB_ACTIONS !== 'true' || process.platform !== 'linux') fail('ACTIONS_LINUX_ONLY');
    const result = await configureRuntimeSecrets({ env: process.env, runAws: awsExecutor(process.env) });
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, Object.entries(result.secretArns).map(([name, value]) => `${name}_secret_arn=${value}`).join('\n') + '\n');
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    process.stderr.write(`Runtime secret configuration failed (${error instanceof RuntimeConfigurationError ? error.code : 'UNEXPECTED_ERROR'}); secret values omitted.\n`);
    process.exitCode = 1;
  }
}
