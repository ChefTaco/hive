// Only known presentation-only PRs may use the smaller real recovery corpus.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function recoveryScope(changes) {
  if (!changes.length) return { full: true, reason: 'empty-or-unknown-diff' };
  for (const { status, oldMode, newMode, path } of changes) {
    if (!['A', 'M'].includes(status) || newMode !== '100644' || (status === 'M' && oldMode !== '100644')) return { full: true, reason: 'special-change' };
    if (!/^[A-Za-z0-9_./-]+$/.test(path) || path.split('/').some((part) => part === '..' || !part)) return { full: true, reason: 'ambiguous-path' };
    const presentation = /^services\/hive-router\/ui\/(src|public)\/.+\.(tsx?|css|svg|png|webp|ico)$/.test(path);
    const prose = /^(README|CONTRIBUTING)\.md$/.test(path);
    if (!presentation && !prose) return { full: true, reason: 'installer-shared-or-unclassified-change' };
  }
  return { full: false, reason: 'presentation-only-pr' };
}

export function parseRawDiff(raw) {
  const fields = raw.split('\0');
  if (fields.pop() !== '') throw Error('Truncated raw diff');
  const changes = [];
  while (fields.length) {
    const header = fields.shift(), path = fields.shift();
    const match = /^:(\d{6}) (\d{6}) [a-f0-9]+ [a-f0-9]+ ([A-Z])$/.exec(header);
    if (!match || path === undefined) throw Error('Ambiguous raw diff');
    changes.push({ oldMode: match[1], newMode: match[2], status: match[3], path });
  }
  return changes;
}

export function classifyEvent(eventName, event, git = (...args) => execFileSync('git', args, { encoding: 'utf8' })) {
  if (eventName !== 'pull_request') return { full: true, reason: 'main-release-or-manual' };
  const base = event.pull_request?.base?.sha, head = event.pull_request?.head?.sha;
  if (![base, head].every((value) => /^[a-f0-9]{40}$/.test(value ?? ''))) return { full: true, reason: 'missing-history' };
  try {
    git('cat-file', '-e', base + '^{commit}'); git('cat-file', '-e', head + '^{commit}');
    // A divergent or rewritten base is uncertain; never narrow it to a convenient merge base.
    git('merge-base', '--is-ancestor', base, head);
    return recoveryScope(parseRawDiff(git('diff', '--raw', '--no-abbrev', '--no-renames', '-z', base, head, '--')));
  } catch { return { full: true, reason: 'unavailable-or-ambiguous-history' }; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let result;
  try { result = classifyEvent(process.env.GITHUB_EVENT_NAME, JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))); }
  catch { result = { full: true, reason: 'unreadable-event' }; }
  console.log(JSON.stringify(result));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `full=${result.full}\nreason=${result.reason}\n`);
}
