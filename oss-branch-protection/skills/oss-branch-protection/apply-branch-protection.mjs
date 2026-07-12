// Apply a uniform branch-protection template to all public non-fork repos in a GitHub org.
// Template: admin-exempt (maintainer keeps direct-commit/force-push), no force-push/deletion
// for others, require conversation resolution, and require CI-to-pass where a stable gate
// exists. Idempotent — safe to re-run. Requires `gh` authed with `repo` scope.
//
//   node apply-branch-protection.mjs --dry   # preview the plan
//   node apply-branch-protection.mjs         # apply
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const ORG = 'sailingnaturali';               // <- set your org
const DRY = process.argv.includes('--dry');
const gh = (args) => JSON.parse(execSync(`gh ${args}`, { encoding: 'utf8', maxBuffer: 1e8 }));

// Non-gating / unstable contexts we never require.
const DROP = (c) =>
  c.includes('${{') ||                       // unrendered matrix template
  /dependabot/i.test(c) ||
  /^deploy$|^publish$/i.test(c) ||           // release/deploy jobs don't report on PRs
  /crosspost|report-build-status|update-uv-graph/i.test(c);

function requiredContexts(checks) {
  // Prefer an aggregate gate (e.g. "plugin-ci / CI Status") — stable across matrix changes.
  if (checks.some((c) => /CI Status/i.test(c))) return checks.filter((c) => /CI Status/i.test(c));
  return checks.filter((c) => !DROP(c));
}

const repos = gh(`repo list ${ORG} --no-archived --limit 100 --json name,visibility,isFork,defaultBranchRef`)
  .filter((r) => r.visibility === 'PUBLIC' && !r.isFork);

const results = [];
for (const r of repos) {
  const branch = r.defaultBranchRef?.name;
  if (!branch) { results.push([r.name, 'SKIP (no default branch)']); continue; }
  let checks = [];
  try {
    const cr = gh(`api repos/${ORG}/${r.name}/commits/${branch}/check-runs`);
    checks = [...new Set((cr.check_runs || []).map((c) => c.name))];
  } catch { /* no checks */ }
  const contexts = requiredContexts(checks);

  const body = {
    required_status_checks: contexts.length ? { strict: true, contexts } : null,
    enforce_admins: false,
    required_pull_request_reviews: null,
    restrictions: null,
    allow_force_pushes: false,
    allow_deletions: false,
    required_conversation_resolution: true,
  };

  if (DRY) { results.push([r.name, `${branch} → checks:[${contexts.join(', ') || '—'}]`]); continue; }

  writeFileSync('/tmp/prot-body.json', JSON.stringify(body));
  try {
    execSync(`gh api -X PUT repos/${ORG}/${r.name}/branches/${branch}/protection --input /tmp/prot-body.json`, { stdio: 'pipe' });
    results.push([r.name, `✅ ${branch} · checks:[${contexts.join(', ') || 'none'}]`]);
  } catch (e) {
    results.push([r.name, `❌ ${branch} · ${String(e.stderr || e).slice(0, 120)}`]);
  }
}

console.log(`\n${DRY ? 'PLAN' : 'APPLIED'} (${results.length} repos):\n`);
for (const [name, status] of results) console.log(`  ${name.padEnd(28)} ${status}`);
