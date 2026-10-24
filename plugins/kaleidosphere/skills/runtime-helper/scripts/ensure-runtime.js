#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function option(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function command(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) return { ok: false, output: '', error: result.error.message };
  if (result.status !== 0) return { ok: false, output: '', error: (result.stderr || result.stdout || '').trim() };
  return { ok: true, output: result.stdout.trim() };
}

function currentKsVersion() {
  const result = command('ks', ['--version']);
  return result.ok ? result.output : null;
}

function runtimeTarball(pluginRoot) {
  const resourcesRoot = path.join(pluginRoot, 'resources');
  if (!fs.existsSync(resourcesRoot)) throw new Error(`plugin resources directory does not exist: ${resourcesRoot}`);
  const matches = fs.readdirSync(resourcesRoot)
    .map((name) => ({ name, match: name.match(/^kaleidosphere-(\d+\.\d+\.\d+)\.tgz$/) }))
    .filter((item) => item.match);
  if (matches.length !== 1) {
    throw new Error(`expected exactly one KaleidoSphere runtime tarball in ${resourcesRoot}`);
  }
  return {
    path: path.join(resourcesRoot, matches[0].name),
    version: matches[0].match[1]
  };
}

function main() {
  const args = process.argv.slice(2);
  const pluginRoot = path.resolve(option(args, '--plugin-root') || path.join(__dirname, '..', '..', '..'));
  const tarball = runtimeTarball(pluginRoot);
  const beforeVersion = currentKsVersion();

  if (beforeVersion === tarball.version) {
    return {
      ok: true,
      updated: false,
      expectedVersion: tarball.version,
      beforeVersion,
      afterVersion: beforeVersion,
      tarball: tarball.path
    };
  }

  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const install = command(npm, ['install', '--global', tarball.path]);
  if (!install.ok) throw new Error(`failed to install bundled KS runtime: ${install.error}`);

  const afterVersion = currentKsVersion();
  if (afterVersion !== tarball.version) {
    throw new Error(`KS runtime version mismatch after installation: expected ${tarball.version}, received ${afterVersion || 'unavailable'}`);
  }
  return {
    ok: true,
    updated: true,
    expectedVersion: tarball.version,
    beforeVersion,
    afterVersion,
    tarball: tarball.path
  };
}

try {
  process.stdout.write(`${JSON.stringify(main())}\n`);
} catch (error) {
  process.stderr.write(`ks runtime: ${error.message}\n`);
  process.exitCode = 1;
}
