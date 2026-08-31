import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isManagedRepoPath, refreshManagedRepo } from './repo-refresh-safety.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-repo-refresh-'));
const CACHE = path.join(TMP, 'data', 'repos');
const ORIGIN = path.join(TMP, 'origin.git');
const SEED = path.join(TMP, 'seed');
const MANAGED = path.join(CACHE, 'demo', 'main');
const EXTERNAL = path.join(TMP, 'developer-worktree');

function git(cwd, ...args) { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function writeAndPush(content, message) {
  fs.writeFileSync(path.join(SEED, 'tracked.txt'), content);
  git(SEED, 'add', 'tracked.txt'); git(SEED, 'commit', '-m', message); git(SEED, 'push', 'origin', 'main');
  return git(SEED, 'rev-parse', 'HEAD');
}

before(() => {
  fs.mkdirSync(CACHE, { recursive: true }); fs.mkdirSync(SEED, { recursive: true });
  git(SEED, 'init', '-b', 'main'); git(SEED, 'config', 'user.email', 'intake-test@example.com'); git(SEED, 'config', 'user.name', 'Intake Test');
  git(TMP, 'init', '--bare', ORIGIN); git(SEED, 'remote', 'add', 'origin', ORIGIN); writeAndPush('v1\n', 'initial');
  git(ORIGIN, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  fs.mkdirSync(path.dirname(MANAGED), { recursive: true }); git(TMP, 'clone', ORIGIN, MANAGED); git(TMP, 'clone', ORIGIN, EXTERNAL);
});
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('路径边界：仅缓存根目录内的真实仓库路径可写', () => {
  assert.equal(isManagedRepoPath(MANAGED, CACHE), true); assert.equal(isManagedRepoPath(EXTERNAL, CACHE), false);
  const alias = path.join(CACHE, 'external-link'); fs.symlinkSync(EXTERNAL, alias);
  assert.equal(isManagedRepoPath(alias, CACHE), false, '指向外部仓的符号链接不得绕过边界');
});

test('干净的 Intake 托管缓存仓可 fetch 并对齐上游', () => {
  const remoteHead = writeAndPush('v2\n', 'remote update'); const oldHead = git(MANAGED, 'rev-parse', 'HEAD');
  assert.notEqual(oldHead, remoteHead);
  const result = refreshManagedRepo({ dir: MANAGED, name: 'demo', cacheRoot: CACHE });
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.skipped, false);
  assert.equal(git(MANAGED, 'rev-parse', 'HEAD'), remoteHead); assert.equal(fs.readFileSync(path.join(MANAGED, 'tracked.txt'), 'utf8'), 'v2\n');
});

test('脏缓存仓 fail closed，不改 HEAD、不覆盖已跟踪/未跟踪文件', () => {
  const localHead = git(MANAGED, 'rev-parse', 'HEAD');
  const fetchedHead = git(MANAGED, 'rev-parse', 'origin/main');
  fs.writeFileSync(path.join(MANAGED, 'tracked.txt'), 'local uncommitted\n'); fs.writeFileSync(path.join(MANAGED, 'untracked.txt'), 'keep me\n');
  const remoteHead = writeAndPush('v3\n', 'another remote update'); assert.notEqual(localHead, remoteHead);
  const result = refreshManagedRepo({ dir: MANAGED, name: 'demo', cacheRoot: CACHE });
  assert.equal(result.ok, false); assert.equal(result.skipped, true); assert.equal(result.reason, 'dirty-worktree');
  assert.equal(git(MANAGED, 'rev-parse', 'HEAD'), localHead); assert.equal(git(MANAGED, 'rev-parse', 'origin/main'), fetchedHead, 'dirty 仓不得执行 fetch');
  assert.equal(fs.readFileSync(path.join(MANAGED, 'tracked.txt'), 'utf8'), 'local uncommitted\n'); assert.equal(fs.readFileSync(path.join(MANAGED, 'untracked.txt'), 'utf8'), 'keep me\n');
});

test('外部开发仓即使干净也只读跳过，不 fetch/reset', () => {
  const before = git(EXTERNAL, 'rev-parse', 'HEAD'), fetchedBefore = git(EXTERNAL, 'rev-parse', 'origin/main');
  const result = refreshManagedRepo({ dir: EXTERNAL, name: 'external', cacheRoot: CACHE });
  assert.equal(result.ok, false); assert.equal(result.skipped, true); assert.equal(result.reason, 'external-worktree');
  assert.equal(git(EXTERNAL, 'rev-parse', 'HEAD'), before); assert.equal(git(EXTERNAL, 'rev-parse', 'origin/main'), fetchedBefore, '外部仓不得执行 fetch');
});

test('server 调用安全刷新并将拒绝原因暴露给手动同步接口', () => {
  const source = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');
  assert.match(source, /refreshManagedRepo\(\{\s*dir,\s*name,\s*cacheRoot: REPOS_CACHE/);
  assert.match(source, /const blockedRepos = repos\.filter\(repo => repo\.skipped\)/);
  assert.match(source, /repos\.every\(repo => repo\.ok\)/);
});
