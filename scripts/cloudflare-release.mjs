import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const upstream = 'https://github.com/shuaiplus/nodewarden.git';
const baseline = 'v1.8.1';
const reviewedConfig = '2bfde78bbd5262a9ef281271da0ae4951682488e';
const { tag, commit } = JSON.parse(readFileSync(new URL('../cf-release.json', import.meta.url), 'utf8'));
const stableTag = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
if (!stableTag.test(tag) || !/^[a-f0-9]{40}$/.test(commit)) {
  throw new Error('The release must have a stable version tag and a full Git commit ID.');
}

const d1 = process.env.CF_NODEWARDEN_D1_ID ?? '';
const kv = process.env.CF_NODEWARDEN_KV_ID ?? '';
if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(d1) || !/^[a-f0-9]{32}$/.test(kv)) {
  throw new Error('Configure CF_NODEWARDEN_D1_ID and CF_NODEWARDEN_KV_ID in Workers Builds.');
}

const checkout = mkdtempSync(join(tmpdir(), 'nodewarden-release-'));
const buildEnv = { ...process.env };
delete buildEnv.CLOUDFLARE_API_TOKEN;
delete buildEnv.CF_API_TOKEN;
delete buildEnv.CLOUDFLARE_API_KEY;
delete buildEnv.CF_API_KEY;
delete buildEnv.CF_NODEWARDEN_D1_ID;
delete buildEnv.CF_NODEWARDEN_KV_ID;

function run(command, args, { capture = false, env = buildEnv } = {}) {
  const output = execFileSync(command, args, {
    cwd: checkout,
    env,
    encoding: 'utf8',
    stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'],
  });
  return output?.trim();
}

try {
  run('git', ['init', '--quiet']);
  run('git', ['fetch', '--quiet', '--no-tags', '--depth=1', upstream, `refs/tags/${tag}`]);
  run('git', ['checkout', '--quiet', '--detach', 'FETCH_HEAD']);
  if (run('git', ['rev-parse', 'HEAD'], { capture: true }) !== commit) {
    throw new Error(`Upstream moved the ${tag} tag. Check the release before proceeding.`);
  }
  if (run('git', ['hash-object', 'wrangler.kv.toml'], { capture: true }) !== reviewedConfig) {
    throw new Error('Upstream changed the KV deployment configuration. Review the bindings and migrations first.');
  }

  console.log(`Building NodeWarden ${tag} from ${commit.slice(0, 12)}`);
  run('npm', ['ci', '--no-audit', '--no-fund']);
  run('npm', ['run', 'build']);

  const configPath = 'wrangler.ci.toml';
  const config = readFileSync(join(checkout, 'wrangler.kv.toml'), 'utf8')
    .replace('[build]\ncommand = "npm run build"', 'keep_vars = true\nworkers_dev = false\npreview_urls = false')
    .replace('database_name = "nodewarden-db"', `database_name = "nodewarden-db"\ndatabase_id = "${d1}"`)
    .replace('binding = "ATTACHMENTS_KV"', `binding = "ATTACHMENTS_KV"\nid = "${kv}"`);
  writeFileSync(join(checkout, configPath), config, { mode: 0o600 });

  const wrangler = './node_modules/.bin/wrangler';
  const configArgs = ['--config', configPath];
  if (tag === baseline) {
    run(wrangler, ['versions', 'upload', '--dry-run', ...configArgs]);
    console.log(`Baseline ${baseline} compiled successfully. The active Worker version was not changed.`);
  } else {
    const versionTag = `nodewarden-${tag}-${commit.slice(0, 12)}`;
    const message = `NodeWarden ${tag} (${commit.slice(0, 12)})`;
    run(wrangler, ['versions', 'upload', ...configArgs, '--tag', versionTag, '--message', message], { env: process.env });
    run(wrangler, ['versions', 'deploy', ...configArgs, '--version-tag', versionTag, '--percentage', '100', '--yes', '--message', message], { env: process.env });
  }
} finally {
  rmSync(checkout, { recursive: true, force: true });
}
