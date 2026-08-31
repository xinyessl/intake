import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function git(dir, args, timeout) {
  return spawnSync('git', ['-c', 'core.quotepath=false', '-C', dir, ...args], {
    encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024,
  });
}

function realPath(target) {
  try { return fs.realpathSync.native(target); } catch { return path.resolve(target); }
}

// 产品开发目录只供 Intake 读取；只有 data/repos 下由 Intake clone 的缓存仓可刷新。
// realpath 后再比较，避免通过 .. 或符号链接把外部工作区伪装成缓存目录。
export function isManagedRepoPath(repoPath, cacheRoot) {
  if (!repoPath || !cacheRoot) return false;
  const repo = realPath(repoPath), cache = realPath(cacheRoot);
  return repo !== cache && repo.startsWith(cache + path.sep);
}

function worktreeState(dir) {
  const result = git(dir, ['status', '--porcelain=v1', '--untracked-files=normal'], 15000);
  if (result.status !== 0) return { ok: false, dirty: false, detail: String(result.stderr || result.error || '').trim() };
  const detail = String(result.stdout || '').trim();
  return { ok: true, dirty: !!detail, detail };
}

function repoSummary(dir) {
  const log = git(dir, ['log', '-1', '--format=%h｜%ci｜%s'], 8000);
  const tagList = git(dir, ['tag', '-l'], 8000);
  return {
    head: log.status === 0 ? String(log.stdout || '').trim().slice(0, 90) : '',
    tags: tagList.status === 0 ? String(tagList.stdout || '').split('\n').filter(Boolean).length : 0,
  };
}

function skipped(name, reason, message, dir) {
  return { name, ok: false, skipped: true, reason, message, dir, ...repoSummary(dir) };
}

// 安全边界：外部 repoPath 永不写；缓存仓 fetch/reset 前均须 clean；fetch 失败不 reset；
// 每个拒绝分支均返回可观测 reason/message。
export function refreshManagedRepo({ dir, name = '', cacheRoot, prepareRemote } = {}) {
  if (!dir || !fs.existsSync(path.join(dir, '.git'))) {
    return { name, ok: false, skipped: true, reason: 'not-git-repository', message: '未找到 Git 仓库', dir: dir || '', head: '', tags: 0 };
  }
  if (!isManagedRepoPath(dir, cacheRoot)) return skipped(name, 'external-worktree', '外部开发仓只读，未执行刷新', dir);

  const beforeFetch = worktreeState(dir);
  if (!beforeFetch.ok) return skipped(name, 'status-check-failed', '无法确认工作区状态，已停止刷新', dir);
  if (beforeFetch.dirty) return skipped(name, 'dirty-worktree', '工作区存在未提交改动，已停止刷新', dir);

  try { if (prepareRemote) prepareRemote(dir); }
  catch (error) { return skipped(name, 'remote-prepare-failed', `远程地址更新失败：${String((error && error.message) || error)}`, dir); }

  const fetchResult = git(dir, ['fetch', '--all', '--tags', '--prune', '--force'], 90000);
  if (fetchResult.status !== 0) return skipped(name, 'fetch-failed', `Git fetch 失败：${String(fetchResult.stderr || fetchResult.error || '').trim()}`, dir);

  // fetch 可能较慢；再次检查，防止等待期间出现未提交改动后被 reset 覆盖。
  const beforeReset = worktreeState(dir);
  if (!beforeReset.ok) return skipped(name, 'status-check-failed-after-fetch', 'fetch 后无法确认工作区状态，未执行 reset', dir);
  if (beforeReset.dirty) return skipped(name, 'dirty-worktree-after-fetch', 'fetch 期间出现未提交改动，未执行 reset', dir);

  const resetResult = git(dir, ['reset', '--hard', '@{u}'], 30000);
  if (resetResult.status !== 0) return skipped(name, 'reset-failed', `无法对齐上游分支：${String(resetResult.stderr || resetResult.error || '').trim()}`, dir);
  return { name, ok: true, skipped: false, reason: '', message: '已同步', dir, ...repoSummary(dir) };
}
