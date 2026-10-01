import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureCollaborationCandidateSnapshot } from '../../../../apps/server/src/services/CollaborationCandidateSnapshot.ts';

// Diagnostic evidence, not a repair regression: exit 0 means the reported
// rejection was reproduced and positive controls passed. It does not close F23.
// Only fresh temporary Git repositories are written. Fixtures are retained.
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const evidence = [];

async function probe({ autocrlf, ending, repetition, expected }) {
  const root = await mkdtemp(join(tmpdir(), 'agentos-20260930-crlf-probe-'));
  const gitBytes = (...args) => execFileSync('git', args, {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const git = (...args) => gitBytes(...args).toString('utf8').trim();
  git('init', '--quiet');
  git('config', 'core.autocrlf', String(autocrlf));
  git('config', 'core.safecrlf', 'false');
  git('config', 'user.name', 'AgentOS Audit Fixture');
  git('config', 'user.email', 'audit@agentos.invalid');
  await mkdir(join(root, 'src'));
  const path = join(root, 'src', 'candidate.txt');
  await writeFile(path, `baseline${ending}`);
  git('add', '--all');
  git('-c', 'core.hooksPath=', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'isolated audit baseline');
  const baseCommit = git('rev-parse', 'HEAD');
  await writeFile(path, `candidate line${ending}`);
  const beforeBytes = await readFile(path);
  const beforeIndex = await readFile(join(root, '.git', 'index'));
  const beforeStatus = gitBytes('status', '--porcelain=v1', '-z');
  const rawGitObject = git('hash-object', '--no-filters', 'src/candidate.txt');
  const cleanGitObject = git('hash-object', '--path=src/candidate.txt', 'src/candidate.txt');
  let result;
  try {
    const snapshot = await captureCollaborationCandidateSnapshot(root, baseCommit, ['src/']);
    result = { outcome: 'accepted', patchHash: snapshot.patchHash, changedPaths: snapshot.changedPaths };
  } catch (error) {
    result = { outcome: 'rejected', code: String(error?.message ?? error).split(':')[0] };
  }
  const sourceStable = hash(beforeBytes) === hash(await readFile(path));
  const indexStable = beforeIndex.equals(await readFile(join(root, '.git', 'index')));
  const statusStable = beforeStatus.equals(gitBytes('status', '--porcelain=v1', '-z'));
  assert.equal(sourceStable, true, 'probe must not modify candidate source during capture');
  assert.equal(indexStable, true, 'capture must not modify the real Git index');
  assert.equal(statusStable, true, 'capture must not change repository status');
  assert.equal(git('rev-parse', 'HEAD'), baseCommit);
  assert.equal(result.outcome, expected);
  if (expected === 'rejected') {
    assert.equal(result.code, 'COLLABORATION_SNAPSHOT_SOURCE_CHANGED');
    assert.notEqual(rawGitObject, cleanGitObject, 'Git clean conversion must be demonstrated');
  } else {
    assert.equal(rawGitObject, cleanGitObject);
  }
  const row = {
    case: expected === 'rejected' ? 'F23_BUG_REPRODUCED' : 'POSITIVE_CONTROL',
    repetition, autocrlf, ending: ending === '\r\n' ? 'CRLF' : 'LF',
    root, baseCommit, rawGitObject, cleanGitObject,
    sourceStable, indexStable, statusStable, ...result,
  };
  evidence.push(row);
  process.stdout.write(`${JSON.stringify(row)}\n`);
}

for (let repetition = 1; repetition <= 3; repetition += 1) {
  await probe({ autocrlf: true, ending: '\r\n', repetition, expected: 'rejected' });
}
await probe({ autocrlf: false, ending: '\r\n', repetition: 1, expected: 'accepted' });
await probe({ autocrlf: false, ending: '\n', repetition: 1, expected: 'accepted' });
process.stdout.write(`${JSON.stringify({
  diagnosticComplete: true, reproduced: 3, positiveControls: 2,
  bugFixed: false, fixtureRoots: evidence.map(row => row.root),
})}\n`);
