import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, sep, basename } from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';
import { configureRuntimeSecrets } from './configure-runtime-secrets.mjs';

const ids = { jwt: 'oficina/fase4/jwt', internal: 'oficina/fase4/auth-client-lookup', os: 'oficina/fase4/os/homolog/runtime', production: 'oficina/homolog/production/application', billing: 'oficina/homolog/billing/runtime' };
const jwt = { secret: 'fixture-access-secret-independent-32-bytes', refreshSecret: 'fixture-refresh-secret-independent-32-bytes' };
const internal = { token: 'fixture-internal-token-independent-32-bytes' };
const mp = { MP_ACCESS_TOKEN: 'opaque-provider-token-with-no-prefix-assumption', MP_WEBHOOK_SECRET: 'fixture-provider-webhook-secret' };
const awsArn = id => `arn:aws:secretsmanager:us-east-1:000000000000:secret:${id}-AbC123`;

async function fixture(t, values = {}) {
  const root = await mkdtemp(join(tmpdir(), 'oficina-secrets-test-'));
  t.after(async () => {
    const target = resolve(root);
    assert.ok(target.startsWith(resolve(tmpdir()) + sep) && /^oficina-secrets-test-[A-Za-z0-9_-]{6,}$/.test(basename(target)));
    await rm(target, { recursive: true, force: true });
  });
  const entries = new Map(Object.entries(values)); const calls = []; const files = [];
  const runAws = async args => {
    calls.push([...args]);
    const operation = args[args.indexOf('secretsmanager') + 1];
    const id = args[args.indexOf(args.includes('--name') ? '--name' : '--secret-id') + 1];
    if (operation === 'describe-secret') {
      if (!entries.has(id)) throw { stderr: 'An error occurred (ResourceNotFoundException) calling DescribeSecret' };
      return JSON.stringify({ ARN: awsArn(id), VersionIdsToStages: entries.get(id) === undefined ? {} : { version: ['AWSCURRENT'] } });
    }
    if (operation === 'get-secret-value') return JSON.stringify(entries.get(id));
    assert.ok(['create-secret', 'put-secret-value'].includes(operation));
    const argument = args[args.indexOf('--secret-string') + 1];
    assert.ok(argument.startsWith('file://'));
    const file = argument.slice(7); files.push(file);
    assert.ok(resolve(file).startsWith(resolve(root) + sep));
    if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
    const content = await readFile(file, 'utf8');
    assert.equal(args.includes(content), false);
    entries.set(id, JSON.parse(content));
    return JSON.stringify({ ARN: awsArn(id) });
  };
  let byte = 1;
  const env = { GITHUB_ACTIONS: 'true', AWS_REGION: 'us-east-1', RUNNER_TEMP: root, RUNTIME_COMPONENT: 'os' };
  const writes = () => calls.filter(args => args.includes('create-secret') || args.includes('put-secret-value'));
  const request = async () => { throw new Error('Unexpected provider request'); };
  const execute = overrides => configureRuntimeSecrets({ env, runAws, request, random: size => Buffer.alloc(size, byte++), ...overrides });
  return { root, entries, calls, files, env, runAws, writes, execute };
}
const shared = () => ({ [ids.jwt]: { ...jwt }, [ids.internal]: { ...internal } });

test('OS initializes independent shared keys and secure admin password once; no secrets in CLI args/result', async t => {
  const f = await fixture(t);
  const result = await f.execute();
  assert.deepEqual(result.changed, ['jwt', 'internal', 'os']);
  const access = f.entries.get(ids.jwt); const lookup = f.entries.get(ids.internal); const runtime = f.entries.get(ids.os);
  assert.notEqual(access.secret, access.refreshSecret);
  for (const value of [access.secret, access.refreshSecret, lookup.token, runtime.ADMIN_SEED_PASSWORD]) {
    assert.ok(Buffer.byteLength(value) >= 32);
    assert.equal(JSON.stringify(f.calls).includes(value), false);
    assert.equal(JSON.stringify(result).includes(value), false);
  }
  assert.equal(runtime.AUTH_CLIENT_LOOKUP_TOKEN, lookup.token);
  assert.deepEqual(await readdir(f.root), []);
  assert.deepEqual((await f.execute()).changed, []);
  assert.equal(f.writes().length, 3);
});

test('OS preserves existing canonical keys and admin password without writing another version', async t => {
  const runtime = { AUTH_CLIENT_LOOKUP_TOKEN: internal.token, ADMIN_SEED_PASSWORD: 'fixture-existing-admin-password-32-bytes' };
  const f = await fixture(t, { ...shared(), [ids.os]: runtime });
  assert.deepEqual((await f.execute()).changed, []);
  assert.equal(f.writes().length, 0);
  assert.deepEqual(f.entries.get(ids.os), runtime);
});

test('OS can adopt its valid existing token and fill only the missing admin password', async t => {
  const f = await fixture(t, { [ids.jwt]: jwt, [ids.os]: { AUTH_CLIENT_LOOKUP_TOKEN: internal.token, keep: 'public-metadata' } });
  await f.execute();
  assert.equal(f.entries.get(ids.internal).token, internal.token);
  assert.equal(f.entries.get(ids.os).AUTH_CLIENT_LOOKUP_TOKEN, internal.token);
  assert.equal(f.entries.get(ids.os).keep, 'public-metadata');
});

test('invalid or mismatched existing values fail before any writes', async t => {
  for (const values of [
    { ...shared(), [ids.jwt]: { secret: jwt.secret, refreshSecret: jwt.secret } },
    { ...shared(), [ids.jwt]: { secret: 'short', refreshSecret: jwt.refreshSecret } },
    { ...shared(), [ids.jwt]: { secret: ' '.repeat(40), refreshSecret: jwt.refreshSecret } },
    { ...shared(), [ids.internal]: { token: 'short' } },
    { ...shared(), [ids.os]: { AUTH_CLIENT_LOOKUP_TOKEN: jwt.secret } },
    { ...shared(), [ids.os]: { AUTH_CLIENT_LOOKUP_TOKEN: internal.token, ADMIN_SEED_PASSWORD: '' } },
  ]) {
    const f = await fixture(t, values);
    await assert.rejects(f.execute(), /INVALID|MISMATCH/);
    assert.equal(f.writes().length, 0);
  }
});

test('Production populates the Terraform-owned metadata only with canonical values and is idempotent', async t => {
  const f = await fixture(t, { ...shared(), [ids.production]: undefined }); f.env.RUNTIME_COMPONENT = 'production';
  await f.execute();
  assert.deepEqual(f.entries.get(ids.production), { JWT_SECRET: jwt.secret, AUTH_CLIENT_LOOKUP_TOKEN: internal.token });
  assert.ok(f.writes()[0].includes('put-secret-value'));
  assert.deepEqual((await f.execute()).changed, []);
  assert.equal(f.writes().length, 1);
});

test('Production requires existing shared secrets and Terraform metadata; refuses mismatches', async t => {
  for (const values of [{}, shared(), { ...shared(), [ids.production]: { JWT_SECRET: jwt.refreshSecret, AUTH_CLIENT_LOOKUP_TOKEN: internal.token } }]) {
    const f = await fixture(t, values); f.env.RUNTIME_COMPONENT = 'production';
    await assert.rejects(f.execute(), /MUST_EXIST|MISMATCH/);
    assert.equal(f.writes().length, 0);
  }
});

test('Billing bootstrap stores only canonical internal token, makes no provider request, and refuses downgrade', async t => {
  const f = await fixture(t, shared()); f.env.RUNTIME_COMPONENT = 'billing'; f.env.BILLING_BOOTSTRAP = 'true'; Object.assign(f.env, mp);
  await f.execute();
  assert.deepEqual(f.entries.get(ids.billing), { AUTH_CLIENT_LOOKUP_TOKEN: internal.token });
  assert.deepEqual((await f.execute()).changed, []);
  for (const pair of [mp, { MP_ACCESS_TOKEN: mp.MP_ACCESS_TOKEN }]) {
    f.entries.set(ids.billing, { AUTH_CLIENT_LOOKUP_TOKEN: internal.token, ...pair });
    await assert.rejects(f.execute(), /ALREADY_HAS_PAYMENT_CREDENTIALS/);
  }
  assert.equal(f.writes().length, 1);
});

test('Billing final validates real test-user MLB metadata, writes the provider pair atomically and never rotates it', async t => {
  const f = await fixture(t, { ...shared(), [ids.billing]: { AUTH_CLIENT_LOOKUP_TOKEN: internal.token } });
  f.env.RUNTIME_COMPONENT = 'billing'; Object.assign(f.env, mp); let requests = 0;
  const request = async (url, options) => { requests++; assert.equal(url, 'https://api.mercadopago.com/users/me'); assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, `Bearer ${mp.MP_ACCESS_TOKEN}`); return { ok: true, json: async () => ({ id: 101, tags: ['test_user'], site_id: 'MLB' }) }; };
  await f.execute({ request });
  assert.equal(f.writes().length, 1);
  assert.deepEqual(f.entries.get(ids.billing), { AUTH_CLIENT_LOOKUP_TOKEN: internal.token, ...mp });
  assert.deepEqual((await f.execute({ request })).changed, []);
  assert.equal(requests, 2);
  f.env.MP_ACCESS_TOKEN = 'different-opaque-test-credential';
  await assert.rejects(f.execute({ request }), /ROTATION_REQUIRES_REVIEW/);
  assert.equal(f.writes().length, 1);
  assert.equal(requests, 2);
});

test('Billing final always requires both GitHub secrets, even with an existing valid pair', async t => {
  for (const supplied of [{}, { MP_ACCESS_TOKEN: mp.MP_ACCESS_TOKEN }, { MP_WEBHOOK_SECRET: mp.MP_WEBHOOK_SECRET }]) {
    const f = await fixture(t, { ...shared(), [ids.billing]: { AUTH_CLIENT_LOOKUP_TOKEN: internal.token, ...mp } }); f.env.RUNTIME_COMPONENT = 'billing'; Object.assign(f.env, supplied);
    await assert.rejects(f.execute(), /PAIR_REQUIRED/);
    assert.equal(f.writes().length, 0);
  }
});

test('Billing rejects non-test sellers, other sites, provider failures and malformed responses without saving tokens', async t => {
  for (const provider of [
    async () => ({ ok: true, json: async () => ({ site_id: 'MLB', tags: ['normal'] }) }),
    async () => ({ ok: true, json: async () => ({ site_id: 'MLA', tags: ['test_user'] }) }),
    async () => ({ ok: false }),
    async () => { throw new Error(mp.MP_ACCESS_TOKEN); },
    async () => ({ ok: true, json: async () => { throw new Error(mp.MP_WEBHOOK_SECRET); } }),
  ]) {
    const f = await fixture(t, shared()); f.env.RUNTIME_COMPONENT = 'billing'; Object.assign(f.env, mp);
    await assert.rejects(f.execute({ request: provider }), error => { assert.match(error.message, /MERCADO_PAGO/); assert.equal(error.message.includes(mp.MP_ACCESS_TOKEN), false); assert.equal(error.message.includes(mp.MP_WEBHOOK_SECRET), false); return true; });
    assert.equal(f.writes().length, 0);
  }
});

test('secret JSON and AWS CLI stderr are sanitized; protected files are removed even on write failure', async t => {
  const f = await fixture(t, shared());
  const malformed = async args => args.includes('get-secret-value') ? 'not-json private-fixture-token' : f.runAws(args);
  await assert.rejects(f.execute({ runAws: malformed }), error => { assert.equal(error.message, 'INVALID_SECRET_JSON'); return true; });
  const failedWrite = async args => { if (args.includes('--secret-string')) throw { stderr: `private-provider-error ${jwt.secret}` }; return f.runAws(args); };
  await assert.rejects(f.execute({ runAws: failedWrite }), error => { assert.equal(error.message, 'AWS_SECRET_WRITE_FAILED'); return true; });
  assert.deepEqual(await readdir(f.root), []);
});

test('rejects missing AWSCURRENT, unsafe IDs and local invocation before secret writes', async t => {
  const f = await fixture(t, shared());
  await assert.rejects(f.execute({ env: { ...f.env, GITHUB_ACTIONS: 'false' } }), /ACTIONS_ONLY/);
  await assert.rejects(f.execute({ env: { ...f.env, JWT_SECRET_ID: 'contains\nnewline' } }), /INVALID_SECRET_IDS/);
  const pending = async args => args.includes('describe-secret') ? JSON.stringify({ ARN: awsArn(ids.jwt), VersionIdsToStages: { pending: ['AWSPENDING'] } }) : f.runAws(args);
  await assert.rejects(f.execute({ runAws: pending }), /CURRENT_VERSION_MISSING/);
  assert.equal(f.writes().length, 0);
});

test('CLI refuses local execution and never prints a supplied secret', () => {
  const cli = fileURLToPath(new URL('./configure-runtime-secrets.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [cli], { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'false', ...mp } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ACTIONS_LINUX_ONLY/);
  assert.equal((result.stdout + result.stderr).includes(mp.MP_ACCESS_TOKEN), false);
  assert.equal((result.stdout + result.stderr).includes(mp.MP_WEBHOOK_SECRET), false);
});
