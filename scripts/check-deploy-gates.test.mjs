import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const code = await readFile(new URL('./check-deploy-gates.mjs', import.meta.url), 'utf8');
const runGate = new (Object.getPrototypeOf(async function () {}).constructor)('process', 'fetch', 'console', code);
const env = { GH_TOKEN: 'fixture-never-used-on-network', GH_REPO: 'owner/repo', TARGET_SHA: 'a'.repeat(40), TARGET_REF: 'feature/phase4-distributed' };
const names = ['Quality', 'Integration', 'Sonar', 'Frontend', 'BDD', 'Container'];
const ci = (overrides = {}) => ({ id: 10, head_sha: env.TARGET_SHA, head_branch: env.TARGET_REF, head_repository: { full_name: env.GH_REPO }, event: 'push', status: 'completed', conclusion: 'success', ...overrides });
const jobs = (overrides = {}) => names.map((name, index) => ({ name, id: index + 1, run_id: 10, head_sha: env.TARGET_SHA, status: 'completed', conclusion: overrides[name] ?? 'success' }));
const branch = { ref: `refs/heads/${env.TARGET_REF}`, object: { sha: env.TARGET_SHA } };
const reply = (runs = [ci()], values = jobs()) => async url => ({ ok: true, json: async () => url.includes('/git/ref/') ? branch : url.includes('/jobs?') ? { jobs: values } : { workflow_runs: runs } });
const execute = (fetch = reply(), variables = env) => runGate({ env: variables }, fetch, { log() {} });

test('accepts all gates from one successful exact branch/SHA CI, including dispatch', async () => {
  await execute();
  await execute(reply([ci({ event: 'workflow_dispatch' })]), { ...env, DISPATCH_SHA: env.TARGET_SHA, DISPATCH_REF: `refs/heads/${env.TARGET_REF}` });
});

test('rejects missing, failed, skipped, foreign-run and newer unsuccessful gates', async () => {
  for (const values of [jobs().slice(1), jobs({ Sonar: 'failure' }), jobs({ BDD: 'skipped' }), jobs().map(job => ({ ...job, run_id: 9 })), [...jobs(), { ...jobs()[0], id: 99, conclusion: 'cancelled' }]]) await assert.rejects(execute(reply([ci()], values)), /Required check/);
});

test('never falls back to an older green run or mixes gates from different runs', async () => {
  for (const latest of [ci({ id: 11, conclusion: 'failure' }), ci({ id: 11, status: 'in_progress', conclusion: null })]) await assert.rejects(execute(reply([ci(), latest])), /Latest CI run/);
  await assert.rejects(execute(reply([ci({ id: 11 })], jobs())), /Required check/);
});

test('rejects foreign repositories, refs, SHAs and pull request merge runs', async () => {
  for (const candidate of [ci({ head_repository: { full_name: 'fork/repo' } }), ci({ head_branch: 'other' }), ci({ head_sha: 'b'.repeat(40) }), ci({ event: 'pull_request' })]) await assert.rejects(execute(reply([candidate])), /Latest CI run/);
});

test('requires dispatch branch and resolved commit to match reviewed inputs', async () => {
  for (const variables of [{ ...env, DISPATCH_SHA: 'b'.repeat(40), DISPATCH_REF: `refs/heads/${env.TARGET_REF}` }, { ...env, DISPATCH_SHA: env.TARGET_SHA, DISPATCH_REF: 'refs/tags/release' }, { ...env, DISPATCH_REF: `refs/heads/${env.TARGET_REF}` }]) await assert.rejects(execute(reply(), variables), /Dispatch ref\/SHA/);
});

test('fails closed on invalid config, unreadable API, changed HEAD or malformed response', async () => {
  await assert.rejects(execute(async () => ({ ok: false, status: 403 })), /HTTP 403/);
  await assert.rejects(execute(async () => ({ ok: true, json: async () => ({}) })), /HEAD/);
  await assert.rejects(execute(async url => ({ ok: true, json: async () => url.includes('/git/ref/') ? branch : {} })), /Unexpected GitHub/);
  for (const variables of [{ ...env, TARGET_SHA: 'main' }, { ...env, TARGET_REF: 'refs/heads/main' }, { ...env, TARGET_REF: '../main' }, { ...env, GH_TOKEN: '' }, { ...env, REQUIRED_DEPLOY_GATES: '' }, { ...env, CI_WORKFLOW_FILE: '../other.yml' }]) await assert.rejects(execute(reply(), variables), /required|configuration/);
});

test('supports explicit constant workflow job lists for other services', async () => {
  const authJobs = ['application', 'terraform'].map((name, id) => ({ name, id, run_id: 10, head_sha: env.TARGET_SHA, status: 'completed', conclusion: 'success' }));
  await execute(reply([ci()], authJobs), { ...env, REQUIRED_DEPLOY_GATES: 'application,terraform' });
  await assert.rejects(execute(reply([ci()], authJobs.slice(1)), { ...env, REQUIRED_DEPLOY_GATES: 'application,terraform' }), /Required check/);
});

test('Production requires its complete quality job including Sonar before deploying', async () => {
  const productionJob = { name: 'Build tests quality', id: 1, run_id: 10, head_sha: env.TARGET_SHA, status: 'completed', conclusion: 'success' };
  const variables = { ...env, REQUIRED_DEPLOY_GATES: 'Build tests quality', CI_WORKFLOW_FILE: 'ci.yml' };
  await execute(reply([ci()], [productionJob]), variables);
  for (const conclusion of ['failure', 'skipped', 'cancelled']) await assert.rejects(execute(reply([ci()], [{ ...productionJob, conclusion }]), variables), /Required check/);
});

test('a stale operational tag cannot deploy after the reviewed source branch advances', async () => {
  await assert.rejects(execute(async url => ({ ok: true, json: async () => url.includes('/git/ref/') ? { ...branch, object: { sha: 'b'.repeat(40) } } : {} })), /no longer HEAD/);
});

test('paginates workflow runs and jobs while preserving the exact run boundary', async () => {
  const requested = [];
  const fetch = async url => {
    requested.push(url);
    const second = url.includes('page=2');
    return { ok: true, json: async () => url.includes('/git/ref/') ? branch : url.includes('/jobs?') ? { jobs: second ? jobs() : Array.from({ length: 100 }, (_, id) => ({ name: 'unrelated', id })) } : { workflow_runs: second ? [ci()] : Array.from({ length: 100 }, (_, id) => ci({ id, head_branch: 'other' })) } };
  };
  await execute(fetch);
  assert.equal(requested.length, 5);
  assert.ok(requested.some(url => url.includes('branch=feature%2Fphase4-distributed')));
  assert.ok(requested.some(url => url.includes('/runs/10/jobs?filter=latest')));
});
