const { GH_TOKEN, GH_REPO, TARGET_SHA, TARGET_REF, DISPATCH_SHA, DISPATCH_REF } = process.env;
// These two values are constants in the reviewed workflow, never dispatch inputs.
const required = (process.env.REQUIRED_DEPLOY_GATES ?? 'Quality,Integration,Sonar,Frontend,BDD,Container').split(',');
const workflow = process.env.CI_WORKFLOW_FILE ?? 'ci.yml';
if (!GH_TOKEN || !/^[\w.-]+\/[\w.-]+$/.test(GH_REPO ?? '') || !/^[a-f0-9]{40}$/.test(TARGET_SHA ?? '') || !/^[\w][\w./-]{0,199}$/.test(TARGET_REF ?? '') || TARGET_REF.includes('..') || TARGET_REF.startsWith('refs/')) throw new Error('GH_TOKEN, GH_REPO, branch TARGET_REF and exact TARGET_SHA required');
if (!/^[\w.-]+\.ya?ml$/.test(workflow) || required.some(name => !/^[\w -]+$/.test(name)) || new Set(required).size !== required.length) throw new Error('Invalid CI workflow or required gate configuration');
if ((DISPATCH_SHA || DISPATCH_REF) && (DISPATCH_SHA !== TARGET_SHA || DISPATCH_REF !== `refs/heads/${TARGET_REF}`)) throw new Error('Dispatch ref/SHA does not match the reviewed branch commit');
const headers = { Authorization: `Bearer ${GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
async function read(path) {
  const response = await fetch(`https://api.github.com/repos/${GH_REPO}/${path}`, { headers, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Unable to verify deploy gates: HTTP ${response.status}`);
  return response.json();
}
async function pages(path, key) {
  const values = [];
  for (let page = 1; page <= 20; page++) {
    const result = await read(`${path}&per_page=100&page=${page}`);
    if (!Array.isArray(result[key])) throw new Error('Unexpected GitHub deploy gate response');
    values.push(...result[key]);
    if (result[key].length < 100) return values;
  }
  throw new Error('Unable to verify deploy gates within the pagination limit');
}
const branch = await read(`git/ref/heads/${TARGET_REF.split('/').map(encodeURIComponent).join('/')}`);
if (branch.ref !== `refs/heads/${TARGET_REF}` || branch.object?.sha !== TARGET_SHA) throw new Error('Reviewed SHA is no longer HEAD of the source branch');
const runs = await pages(`actions/workflows/${workflow}/runs?head_sha=${TARGET_SHA}&branch=${encodeURIComponent(TARGET_REF)}`, 'workflow_runs');
const run = runs.filter(item => item.head_sha === TARGET_SHA && item.head_branch === TARGET_REF && item.head_repository?.full_name?.toLowerCase() === GH_REPO.toLowerCase() && ['push', 'workflow_dispatch'].includes(item.event)).sort((a, b) => b.id - a.id)[0];
if (!run || run.status !== 'completed' || run.conclusion !== 'success') throw new Error('Latest CI run for this repository, branch and SHA is missing or unsuccessful');
const jobs = await pages(`actions/runs/${run.id}/jobs?filter=latest`, 'jobs');
for (const name of required) {
  const matches = jobs.filter(job => job.name === name && job.run_id === run.id && job.head_sha === TARGET_SHA).sort((a, b) => b.id - a.id);
  if (matches[0]?.status !== 'completed' || matches[0]?.conclusion !== 'success') throw new Error(`Required check missing or unsuccessful: ${name}`);
}
console.log(`All ${required.length} required checks passed for ${TARGET_REF}@${TARGET_SHA}; CI run https://github.com/${GH_REPO}/actions/runs/${run.id}`);
