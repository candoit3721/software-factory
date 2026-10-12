/**
 * Tests for scripts/setup.mjs (the npx installer) against a stub `claude`
 * command, so they run offline and never touch the real Claude Code setup.
 * Run with: node --test tests/
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SETUP = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'setup.mjs');
let sandbox;
let env;

/** A fake `claude` CLI: logs every call and mimics how plugin commands edit project settings. */
const STUB = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CLAUDE_STUB_LOG, args.join(' ') + '\\n');
const state = process.env.CLAUDE_STUB_STATE;
const installed = fs.existsSync(state) ? fs.readFileSync(state, 'utf8').split('\\n').filter(Boolean) : [];
const settingsPath = path.join(process.cwd(), '.claude', 'settings.json');
const settings = () => (fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {});
const save = (s) => { fs.mkdirSync(path.dirname(settingsPath), { recursive: true }); fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2) + '\\n'); };
const [a, b, c] = args;
if (a === '--version') { console.log('2.1.0 (Claude Code)'); process.exit(0); }
if (a === 'plugin' && b === 'marketplace' && c === 'add') {
  const name = process.env.CLAUDE_STUB_MARKETPLACE || 'software-factory';
  const s = settings(); s.extraKnownMarketplaces = { ...s.extraKnownMarketplaces, [name]: { source: { source: 'github', repo: args[3] } } }; save(s);
  console.log('Adding marketplace...'); console.log(JSON.stringify({ command: 'marketplace-add', outcome: 'ok', marketplace: name })); process.exit(0);
}
if (a === 'plugin' && b === 'marketplace') process.exit(0);
if (a === 'plugin' && b === 'list') { console.log(installed.map((id) => '  > ' + id).join('\\n')); process.exit(0); }
if (a === 'plugin' && b === 'install') {
  fs.writeFileSync(state, [...installed, c].join('\\n')); const s = settings(); s.enabledPlugins = { ...s.enabledPlugins, [c]: true }; save(s); process.exit(0);
}
if (a === 'plugin' && (b === 'uninstall' || b === 'update')) {
  if (b === 'uninstall') fs.writeFileSync(state, installed.filter((id) => id !== c).join('\\n'));
  process.exit(0);
}
process.exit(0);
`;

function setup(args, cwd) {
  const result = spawnSync('node', [SETUP, ...args], { cwd, env, encoding: 'utf8' });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

const log = () => readFileSync(env.CLAUDE_STUB_LOG, 'utf8');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const settingsOf = (root) => JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8'));

before(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'factory-setup-')));
  const bin = join(sandbox, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'claude'), STUB);
  chmodSync(join(bin, 'claude'), 0o755);
  env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    SOFTWARE_FACTORY_HOME: join(sandbox, 'home'),
    CLAUDE_STUB_LOG: join(sandbox, 'claude.log'),
    CLAUDE_STUB_STATE: join(sandbox, 'installed.txt'),
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
});

after(() => rmSync(sandbox, { recursive: true, force: true }));

describe('setup.mjs', () => {
  let app;

  it('turns a brand-new folder into a factory project with one command', () => {
    app = join(sandbox, 'my-app');
    const { status, out } = setup(['my-app'], sandbox);
    assert.equal(status, 0, out);
    assert.equal(git(app, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
    assert.deepEqual(settingsOf(app).enabledPlugins, { 'factory@software-factory': true });
    assert.equal(settingsOf(app).extraKnownMarketplaces['software-factory'].source.repo, 'candoit3721/software-factory');
    for (const file of ['profile.md', 'backlog.md', 'reviewers/code.md', 'reviewers/experience.md']) {
      assert.ok(existsSync(join(app, 'factory', file)), file);
    }
    assert.match(readFileSync(join(app, '.gitignore'), 'utf8'), /factory\/jobs\/\nfactory\/board\.json/);
    assert.equal(git(app, 'log', '--format=%s'), 'chore: initial commit with the software factory');
    assert.equal(git(app, 'status', '--porcelain'), '');
    const registry = JSON.parse(readFileSync(join(sandbox, 'home', 'projects.json'), 'utf8'));
    assert.deepEqual(registry.projects.map((p) => p.root), [app]);
    assert.match(out, /run \/factory:init/);
  });

  it('updates instead of reinstalling, and keeps edited files, when run again', () => {
    writeFileSync(join(app, 'factory', 'backlog.md'), '# My backlog\n');
    git(app, 'commit', '-qam', 'edit backlog');
    writeFileSync(env.CLAUDE_STUB_LOG, '');
    const { status, out } = setup([], app);
    assert.equal(status, 0, out);
    assert.match(log(), /plugin update factory@software-factory --scope project/);
    assert.doesNotMatch(log(), /plugin install/);
    assert.equal(readFileSync(join(app, 'factory', 'backlog.md'), 'utf8'), '# My backlog\n');
    assert.match(out, /Nothing new to commit/);
    assert.equal(readFileSync(join(app, '.gitignore'), 'utf8').match(/factory\/jobs\//g).length, 1);
  });

  it('commits only its own files, leaving the user\'s work uncommitted', () => {
    const project = join(sandbox, 'existing');
    mkdirSync(project);
    git(project, 'init', '-q', '-b', 'main');
    writeFileSync(join(project, 'app.js'), 'console.log(1)\n');
    git(project, 'add', 'app.js');
    git(project, 'commit', '-qm', 'app');
    writeFileSync(join(project, 'app.js'), 'console.log(2)\n');
    const { status, out } = setup([], project);
    assert.equal(status, 0, out);
    assert.equal(git(project, 'log', '-1', '--format=%s'), 'chore: install the software factory');
    assert.equal(git(project, 'status', '--porcelain'), 'M app.js');
  });

  it('migrates a project from the old locally-installed factory', () => {
    const project = join(sandbox, 'legacy');
    mkdirSync(join(project, '.claude'), { recursive: true });
    git(project, 'init', '-q', '-b', 'main');
    writeFileSync(
      join(project, '.claude', 'settings.json'),
      JSON.stringify({
        enabledPlugins: { 'factory@software-factory-local': true, 'other@market': true },
        extraKnownMarketplaces: { 'software-factory-local': { source: { source: 'directory', path: '/x' } } },
      }),
    );
    writeFileSync(env.CLAUDE_STUB_LOG, '');
    const { status, out } = setup(['--no-commit'], project);
    assert.equal(status, 0, out);
    assert.match(log(), /plugin uninstall factory@software-factory-local --scope project/);
    const settings = settingsOf(project);
    assert.deepEqual(settings.enabledPlugins, { 'other@market': true, 'factory@software-factory': true });
    assert.deepEqual(Object.keys(settings.extraKnownMarketplaces), ['software-factory']);
    assert.match(out, /--no-commit/);
    assert.ok(git(project, 'status', '--porcelain').includes('factory/'));
  });

  it('installs from a fork with --repo', () => {
    writeFileSync(env.CLAUDE_STUB_LOG, '');
    const { status } = setup(['fork-app', '--repo', 'someone/fork', '--no-commit'], sandbox);
    assert.equal(status, 0);
    assert.match(log(), /plugin marketplace add someone\/fork --scope project/);
  });

  it('removes the factory from a project with --remove, keeping its files', () => {
    writeFileSync(env.CLAUDE_STUB_LOG, '');
    const { status, out } = setup(['--remove'], app);
    assert.equal(status, 0, out);
    assert.match(log(), /plugin uninstall factory@software-factory --scope project/);
    const settings = settingsOf(app);
    assert.deepEqual(settings.enabledPlugins, {});
    assert.deepEqual(settings.extraKnownMarketplaces, {});
    assert.ok(existsSync(join(app, 'factory', 'profile.md')));
    const registry = JSON.parse(readFileSync(join(sandbox, 'home', 'projects.json'), 'utf8'));
    assert.ok(!registry.projects.some((p) => p.root === app));
  });

  it('uses the marketplace name Claude Code reports, even an older one', () => {
    writeFileSync(env.CLAUDE_STUB_LOG, '');
    const result = spawnSync('node', [SETUP, 'renamed-app', '--no-commit'], {
      cwd: sandbox,
      env: { ...env, CLAUDE_STUB_MARKETPLACE: 'software-factory-local' },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(log(), /plugin install factory@software-factory-local --scope project/);
    assert.doesNotMatch(log(), /plugin uninstall/);
    assert.deepEqual(settingsOf(join(sandbox, 'renamed-app')).enabledPlugins, { 'factory@software-factory-local': true });
  });

  it('stops with a clear message when the marketplace cannot be added', () => {
    const failing = join(sandbox, 'bin-fail');
    mkdirSync(failing, { recursive: true });
    writeFileSync(
      join(failing, 'claude'),
      '#!/usr/bin/env node\nif (process.argv[2] === "--version") { console.log("2"); process.exit(0); }\nconsole.error("repository not found"); process.exit(1);\n',
    );
    chmodSync(join(failing, 'claude'), 0o755);
    const result = spawnSync('node', [SETUP, 'broken-app'], {
      cwd: sandbox,
      env: { ...env, PATH: `${failing}:${process.env.PATH}` },
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /could not add the marketplace candoit3721\/software-factory:\nrepository not found/);
  });

  it('rejects unknown options', () => {
    const { status, out } = setup(['--frobnicate'], sandbox);
    assert.equal(status, 2);
    assert.match(out, /Unknown option: --frobnicate/);
  });
});
