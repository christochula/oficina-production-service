import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

class PlanValidationError extends Error {
  constructor(message, reason) { super(message); this.reason = reason; }
}

export function validateMetadata(metadata) {
  const checks = {
    repository: /^[\w.-]+\/[\w.-]+$/.test(metadata?.repository ?? ''),
    target_sha: /^[a-f0-9]{40}$/.test(metadata?.target_sha ?? ''),
    target_ref: /^[\w][\w./-]{0,199}$/.test(metadata?.target_ref ?? ''),
    workflow: /^[\w.-]+\.ya?ml$/.test(metadata?.workflow ?? ''),
    operation: ['plan', 'apply'].includes(metadata?.operation),
    run_id: /^[1-9]\d*$/.test(metadata?.run_id ?? ''),
    scope: /^[\w.-]+$/.test(metadata?.scope ?? ''),
  };
  for (const [field, valid] of Object.entries(checks)) {
    if (!valid) throw new PlanValidationError(`Invalid public plan review metadata: ${field}`, `INVALID_METADATA_${field.toUpperCase()}`);
  }
}

export function metadataFromEnvironment(env = process.env) {
  return { repository: env.GH_REPO || env.GITHUB_REPOSITORY, target_sha: env.TARGET_SHA, target_ref: env.TARGET_REF,
    workflow: env.PLAN_WORKFLOW_FILE, operation: env.PLAN_OPERATION, run_id: env.GITHUB_RUN_ID, scope: env.PLAN_SCOPE ?? 'default' };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

export function fingerprintPlan(plan, metadata) {
  validateMetadata(metadata);
  if (!plan || typeof plan.format_version !== 'string' || plan.resource_changes !== undefined && !Array.isArray(plan.resource_changes)) throw new PlanValidationError('Invalid Terraform plan structure', 'INVALID_PLAN_STRUCTURE');
  const resources = (plan.resource_changes ?? []).map(resource => {
    if (!Array.isArray(resource.change?.actions)) throw new PlanValidationError('Invalid Terraform resource actions', 'INVALID_RESOURCE_ACTIONS');
    if (resource.change.actions.includes('delete')) throw new PlanValidationError('Resource deletion or replacement is forbidden', 'DESTRUCTIVE_PLAN');
    return Object.fromEntries(['address', 'previous_address', 'module_address', 'mode', 'type', 'name', 'index', 'provider_name', 'deposed', 'change'].filter(key => resource[key] !== undefined).map(key => [key, resource[key]]));
  }).sort((a, b) => `${a.address}:${a.deposed ?? ''}`.localeCompare(`${b.address}:${b.deposed ?? ''}`));
  // Hash actual before/after values, including sensitive attributes. None are emitted.
  // Top-level plan timestamps, checks and UI rendering are intentionally excluded.
  const semantic = canonical({ format_version: plan.format_version, resource_changes: resources, output_changes: plan.output_changes ?? {} });
  const publicMetadata = Object.fromEntries(['repository', 'target_sha', 'target_ref', 'workflow', 'operation', 'run_id', 'scope'].map(key => [key, String(metadata[key])]));
  return { schema_version: 1, ...publicMetadata, sha256: createHash('sha256').update(JSON.stringify(semantic)).digest('hex') };
}

export function compareReviews(approved, current) {
  if (approved?.schema_version !== 1 || current?.schema_version !== 1 || approved.operation !== 'plan' || current.operation !== 'apply' || !/^[a-f0-9]{64}$/.test(approved.sha256 ?? '') || approved.sha256 !== current.sha256 || ['repository', 'target_sha', 'target_ref', 'workflow', 'scope'].some(key => !approved[key] || approved[key] !== current[key])) throw new PlanValidationError('Plan fingerprint or reviewed source changed; request a new plan review', 'REVIEW_CHANGED');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === '--compare' && process.argv.length === 5) {
      compareReviews(JSON.parse(readFileSync(process.argv[3], 'utf8')), JSON.parse(readFileSync(process.argv[4], 'utf8')));
      process.stdout.write('Reviewed plan fingerprint matches.\n');
    } else if (process.argv[2] === '--validate-environment' && process.argv.length === 3) {
      validateMetadata(metadataFromEnvironment());
      process.stdout.write('Public plan review metadata is valid.\n');
    } else if (process.argv.length === 2) {
      const metadata = metadataFromEnvironment();
      validateMetadata(metadata);
      // A Terraform pipe may deliver a large JSON document in delayed chunks.
      // readFileSync(0) can fail with EAGAIN on Linux; wait asynchronously for EOF.
      process.stdin.setEncoding('utf8');
      let input = '';
      for await (const chunk of process.stdin) input += chunk;
      process.stdout.write(JSON.stringify(fingerprintPlan(JSON.parse(input), metadata)) + '\n');
    } else throw new PlanValidationError('Invalid plan fingerprint arguments', 'INVALID_ARGUMENTS');
  } catch (error) {
    const reason = error instanceof PlanValidationError ? error.reason : error instanceof SyntaxError ? 'INVALID_JSON' : 'INPUT_READ_OR_PROCESSING_FAILED';
    process.stderr.write(`Plan fingerprint validation failed [${reason}]; raw Terraform values are omitted.\n`);
    process.exitCode = 1;
  }
}
