/* global structuredClone */
import { test } from 'node:test';
import process from 'node:process';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath, URL } from 'node:url';
import { fingerprintPlan, compareReviews } from './terraform-plan-fingerprint.mjs';
const metadata = { repository: 'owner/repo', target_sha: 'a'.repeat(40), target_ref: 'feature/demo', workflow: 'infra-phase4.yml', operation: 'plan', run_id: '10', scope: 'default' };
const plan = { format_version: '1.2', timestamp: 'first-run', resource_changes: [{ address: 'aws_secretsmanager_secret_version.runtime', type: 'aws_secretsmanager_secret_version', change: { actions: ['create'], before: null, after: { secret_string: 'private-fixture-do-not-emit', name: 'runtime' }, after_sensitive: { secret_string: true }, after_unknown: { id: true } } }], output_changes: { id: { actions: ['create'], after_unknown: true } } };
const review = () => fingerprintPlan(plan, metadata);

test('fingerprint emits only public metadata and hash, never resource or secret values', () => {
  const result = review();
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result).includes('private-fixture-do-not-emit'), false);
  assert.equal(JSON.stringify(result).includes('secret_string'), false);
  assert.equal('unexpected_secret' in fingerprintPlan(plan, { ...metadata, unexpected_secret: 'must-never-emit' }), false);
});

test('ignores timestamp/object/resource ordering noise but detects sensitive value drift', () => {
  const reordered = { resource_changes: [{ change: { after_unknown: { id: true }, after_sensitive: { secret_string: true }, after: { name: 'runtime', secret_string: 'private-fixture-do-not-emit' }, before: null, actions: ['create'] }, type: 'aws_secretsmanager_secret_version', address: 'aws_secretsmanager_secret_version.runtime' }], format_version: '1.2', timestamp: 'second-run', output_changes: plan.output_changes };
  assert.equal(fingerprintPlan(reordered, metadata).sha256, review().sha256);
  const changed = structuredClone(plan); changed.resource_changes[0].change.after.secret_string = 'different-private-value';
  assert.notEqual(fingerprintPlan(changed, metadata).sha256, review().sha256);
  const multiple = { ...plan, resource_changes: [...plan.resource_changes, { address: 'aws_sqs_queue.commands', change: { actions: ['create'], after: { name: 'commands' } } }] };
  assert.equal(fingerprintPlan(multiple, metadata).sha256, fingerprintPlan({ ...multiple, resource_changes: [...multiple.resource_changes].reverse() }, metadata).sha256);
});

test('blocks deletion/replacement and invalid metadata', () => {
  for (const actions of [['delete'], ['create', 'delete'], ['delete', 'create']]) {
    const changed = structuredClone(plan); changed.resource_changes[0].change.actions = actions;
    assert.throws(() => fingerprintPlan(changed, metadata), /forbidden/);
  }
  assert.throws(() => fingerprintPlan(plan, { ...metadata, target_sha: 'main' }), /metadata/);
});

test('requires identical semantic hash, source, workflow and scope across reviewed plan/apply', () => {
  const approved = review(); const current = { ...approved, operation: 'apply', run_id: '11' };
  compareReviews(approved, current);
  for (const changed of [{ sha256: 'b'.repeat(64) }, { target_sha: 'b'.repeat(40) }, { target_ref: 'other' }, { workflow: 'deploy.yml' }, { scope: 'observability' }, { operation: 'plan' }]) assert.throws(() => compareReviews(approved, { ...current, ...changed }), /changed/);
});

test('CLI accepts GitHub runner metadata and a large plan delivered in delayed pipe chunks', async () => {
  const env = { ...process.env, GITHUB_REPOSITORY: 'christochula/oficina-infra-kubernetes',
    TARGET_SHA: 'd99eeede7aacfd865e9f36f573a2000dca0add0f', TARGET_REF: 'feature/phase4-distributed',
    PLAN_WORKFLOW_FILE: 'deploy.yml', PLAN_OPERATION: 'plan', GITHUB_RUN_ID: '42137993054', PLAN_SCOPE: 'aws' };
  delete env.GH_REPO;
  const child = spawn(process.execPath, [fileURLToPath(new URL('./terraform-plan-fingerprint.mjs', import.meta.url))], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', value => { stdout += value; });
  child.stderr.on('data', value => { stderr += value; });
  child.stdin.on('error', () => {});
  const completed = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => resolve(code)); });
  const input = JSON.stringify({ ...plan, description: 'public-fixture'.repeat(100000) });
  for (let index = 0; index < input.length && !child.stdin.destroyed; index += 8192) {
    child.stdin.write(input.slice(index, index + 8192));
    await setTimeout(5);
  }
  child.stdin.end();
  assert.equal(await completed, 0, stderr);
  const review = JSON.parse(stdout);
  assert.equal(review.repository, env.GITHUB_REPOSITORY);
  assert.equal(review.workflow, 'deploy.yml');
  assert.equal(review.run_id, '42137993054');
  assert.match(review.sha256, /^[a-f0-9]{64}$/);
  assert.equal(stdout.includes('private-fixture-do-not-emit'), false);
});

test('CLI preflight and failures identify only static fields/reasons, never input values', () => {
  const env = { ...process.env, GH_REPO: '', GITHUB_REPOSITORY: 'owner/repo', TARGET_SHA: 'a'.repeat(40), TARGET_REF: 'feature/demo',
    PLAN_WORKFLOW_FILE: 'deploy.yml', PLAN_OPERATION: 'plan', GITHUB_RUN_ID: '42137993054', PLAN_SCOPE: 'aws' };
  const script = fileURLToPath(new URL('./terraform-plan-fingerprint.mjs', import.meta.url));
  const preflight = spawnSync(process.execPath, [script, '--validate-environment'], { env, encoding: 'utf8' });
  assert.equal(preflight.status, 0, preflight.stderr);
  assert.equal(preflight.stdout, 'Public plan review metadata is valid.\n');
  const invalidMetadata = spawnSync(process.execPath, [script, '--validate-environment'], { env: { ...env, PLAN_WORKFLOW_FILE: 'private-fixture-do-not-emit' }, encoding: 'utf8' });
  assert.equal(invalidMetadata.status, 1);
  assert.match(invalidMetadata.stderr, /\[INVALID_METADATA_WORKFLOW\]/);
  assert.equal(invalidMetadata.stderr.includes('private-fixture-do-not-emit'), false);
  const malformed = spawnSync(process.execPath, [script], { env, input: '{"secret":"private-fixture-do-not-emit"', encoding: 'utf8' });
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /\[INVALID_JSON\]/);
  assert.equal(malformed.stdout, '');
  assert.equal(malformed.stderr.includes('private-fixture-do-not-emit'), false);
});
