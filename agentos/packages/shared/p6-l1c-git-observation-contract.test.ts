import assert from 'node:assert/strict';
import test from 'node:test';
import type { RuntimeEventContext } from './src/index.ts';
import {
  CANONICAL_DIFF_ARTIFACT_COMMIT_ORDER_V1,
  CANONICAL_DIFF_ARTIFACT_CRASH_POLICY_V1,
  GIT_CHANGED_FILES_LIMITS_V1,
  GIT_CHANGED_FILES_SCHEMA_VERSION,
  GIT_COMMAND_DIAGNOSTIC_LIMIT_BYTES_V1,
  GIT_COMMAND_EXECUTION_CONTRACT_V1,
  GIT_COMMAND_STDOUT_LIMITS_V1,
  GIT_C_LOCALE_UNBORN_HEAD_DIAGNOSTIC_V1,
  GIT_OBSERVATION_EVENT_SOURCES_V1,
  GIT_OBSERVATION_SCHEMA_VERSION,
  canCommitCanonicalDiffArtifactV1,
  canEmitCanonicalGitObservationEventV1,
  classifyDiffResultV1,
  classifyDirtyStateV1,
  classifyGitObservationV1,
  classifyHeadCommitResultV1,
  classifyRepositoryDiscoveryResultV1,
  createChangedFilesV1,
  mapGitObservationEventDirtyStateV1,
  parseGitCommitObjectIdV1,
  serializeChangedFilesV1,
  serializeGitObservationSnapshotV1,
  type ChangedFileV1,
  type ClassifyGitObservationInputV1,
  type GitCommandPort,
  type GitCommandRequestV1,
  type GitCommandResultV1,
  type GitCommitObjectIdV1,
  type GitObservationEventBindingV1,
  type GitObservationRuntimeEventContextAuthorityV1,
  type GitObservationSnapshotV1,
  type GitObservationStatusResultV1,
  type RuntimeEventContextAuthoritySourceV1,
} from './src/index.ts';

const encoder = new TextEncoder();

function bytes(value = ''): Uint8Array {
  return encoder.encode(value);
}

function exited(exitCode: number, stdout = '', stderr = ''): GitCommandResultV1 {
  return {
    termination: 'exited',
    exitCode,
    stdout: bytes(stdout),
    stderrDiagnostic: bytes(stderr),
    stderrDiagnosticTruncated: false,
  };
}

function commitId(value: string): GitCommitObjectIdV1 {
  const parsed = parseGitCommitObjectIdV1(value);
  if (parsed === null) throw new Error(`expected valid commit object ID: ${value}`);
  return parsed;
}

function completeStatus(entries: readonly ChangedFileV1[]): GitObservationStatusResultV1 {
  return {
    ok: true,
    statusCompleteness: 'complete',
    changedFiles: createChangedFilesV1(entries),
  };
}

const trackedFile: ChangedFileV1 = {
  path: 'src/file.ts',
  kind: 'modified',
  staged: true,
  unstaged: false,
  previousPath: null,
};

test('L1C-M1-01 versioned snapshot and changed-files contracts omit raw stderr', () => {
  assert.equal(GIT_OBSERVATION_SCHEMA_VERSION, 1);
  assert.equal(GIT_CHANGED_FILES_SCHEMA_VERSION, 1);

  const snapshot: GitObservationSnapshotV1 = {
    schemaVersion: 1,
    trigger: 'on_demand',
    observationState: 'NOT_GIT',
    repositoryRoot: null,
    cwd: 'C:/workspace',
    baseCommitSha: null,
    finalCommitSha: null,
    dirtyState: 'not_applicable',
    statusCompleteness: 'not_applicable',
    changedFiles: null,
    diffState: 'not_applicable',
    truncation: { changedFiles: false, diff: false },
    error: null,
    subfailures: [],
  };
  assert.equal(snapshot.schemaVersion, 1);
  // @ts-expect-error raw stderr is deliberately not part of the public snapshot contract
  snapshot.rawStderr = 'fatal: secret path';
});

test('L1C-M1-02 changed files serialize deterministically with explicit limits', () => {
  assert.deepEqual(GIT_CHANGED_FILES_LIMITS_V1, {
    maximumEntries: 4096,
    maximumSerializedBytes: 524288,
  });
  const a: ChangedFileV1 = { ...trackedFile, path: 'z.ts' };
  const b: ChangedFileV1 = { ...trackedFile, path: 'a.ts', staged: false, unstaged: true };
  const forward = createChangedFilesV1([a, b]);
  const reverse = createChangedFilesV1([b, a]);
  assert.deepEqual(forward.entries.map(entry => entry.path), ['a.ts', 'z.ts']);
  assert.equal(serializeChangedFilesV1(forward), serializeChangedFilesV1(reverse));
  assert.ok(Buffer.byteLength(serializeChangedFilesV1(forward), 'utf8') <= forward.maximumSerializedBytes);
});

test('L1C-M1-03 command execution contract freezes C locale and side-effect guards', () => {
  assert.equal(GIT_COMMAND_DIAGNOSTIC_LIMIT_BYTES_V1, 16384);
  assert.deepEqual(GIT_COMMAND_EXECUTION_CONTRACT_V1, {
    environment: {
      LC_ALL: 'C',
      LANG: 'C',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0',
    },
    pagerDisabled: true,
    externalDiffDisabled: true,
    stdoutMaximumBytes: {
      repository_root: 4096,
      head_commit: 4096,
      porcelain_v2_status: 1024 * 1024,
      bounded_diff: 4 * 1024 * 1024,
    },
  });
});

test('L1C-M1-04 GitCommandPort accepts only structured read families', async () => {
  const result = exited(0, 'C:/repo\n');
  class FixtureGitCommandPort implements GitCommandPort {
    readonly executionContract = GIT_COMMAND_EXECUTION_CONTRACT_V1;
    readonly requests: GitCommandRequestV1[] = [];
    async execute(request: GitCommandRequestV1): Promise<GitCommandResultV1> {
      this.requests.push(request);
      return result;
    }
  }
  const port = new FixtureGitCommandPort();
  const request: GitCommandRequestV1 = { family: 'repository_root', cwd: 'C:/repo' };
  assert.equal(await port.execute(request), result);
  assert.deepEqual(port.requests, [request]);

  // @ts-expect-error mutation command families are intentionally unrepresentable
  const forbiddenReset: GitCommandRequestV1 = { family: 'reset', cwd: 'C:/repo' };
  const forbiddenArgv: GitCommandRequestV1 = {
    family: 'bounded_diff',
    cwd: 'C:/repo',
    baseCommitSha: commitId('a'.repeat(40)),
    workspacePathFromRepositoryRoot: '',
    // @ts-expect-error raw argv is intentionally unrepresentable
    argv: ['push'],
  };
  void forbiddenReset;
  void forbiddenArgv;
});

test('L1C-M1-R01 raw stdout limits are finite per read family and not caller-sized', () => {
  assert.deepEqual(GIT_COMMAND_STDOUT_LIMITS_V1, {
    repository_root: 4096,
    head_commit: 4096,
    porcelain_v2_status: 1024 * 1024,
    bounded_diff: 4 * 1024 * 1024,
  });
  for (const limit of Object.values(GIT_COMMAND_STDOUT_LIMITS_V1)) {
    assert.equal(Number.isSafeInteger(limit), true);
    assert.ok(limit > 0);
  }

  const callerSized: GitCommandRequestV1 = {
    family: 'bounded_diff',
    cwd: 'C:/repo',
    baseCommitSha: commitId('a'.repeat(40)),
    workspacePathFromRepositoryRoot: '',
    // @ts-expect-error callers cannot override the finite family limit
    maximumOutputBytes: Number.MAX_SAFE_INTEGER,
  };
  void callerSized;
});

test('L1C-M1-05 ordinary bounded C-locale non-repository diagnostic maps to NOT_GIT', () => {
  const result = classifyRepositoryDiscoveryResultV1(exited(
    128,
    '',
    'fatal: not a git repository (or any of the parent directories): .git\n',
  ));
  assert.deepEqual(result, { observationState: 'NOT_GIT', repositoryRoot: null, error: null });
});

test('L1C-M1-06 dubious ownership maps to UNAVAILABLE', () => {
  const result = classifyRepositoryDiscoveryResultV1(exited(
    128,
    '',
    "fatal: detected dubious ownership in repository at 'C:/repo'\n",
  ));
  assert.equal(result.observationState, 'UNAVAILABLE');
  assert.equal(result.error?.code, 'GIT_DUBIOUS_OWNERSHIP');
});

test('L1C-M1-07 permission-like discovery failure maps to UNAVAILABLE', () => {
  const result = classifyRepositoryDiscoveryResultV1(exited(128, '', 'fatal: Permission denied\n'));
  assert.equal(result.observationState, 'UNAVAILABLE');
  assert.equal(result.error?.code, 'GIT_PERMISSION_DENIED');
});

test('L1C-M1-08 unknown exit 128 never maps to NOT_GIT', () => {
  const result = classifyRepositoryDiscoveryResultV1(exited(128, '', 'fatal: malformed object database\n'));
  assert.equal(result.observationState, 'UNAVAILABLE');
  assert.equal(result.error?.code, 'GIT_REPOSITORY_DISCOVERY_FAILED');
});

test('L1C-M1-R02 truncated discovery diagnostics cannot prove NOT_GIT', () => {
  const result = classifyRepositoryDiscoveryResultV1({
    ...exited(
      128,
      '',
      'fatal: not a git repository (or any of the parent directories): .git\n',
    ),
    stderrDiagnosticTruncated: true,
  });
  assert.equal(result.observationState, 'UNAVAILABLE');
  assert.equal(result.error?.code, 'GIT_REPOSITORY_DISCOVERY_FAILED');
});

test('L1C-M1-09 timeout, cancellation, output overflow and spawn failure remain distinct', () => {
  const cases: Array<[GitCommandResultV1, string]> = [
    [{ termination: 'timed_out', exitCode: null, stdout: bytes(), stderrDiagnostic: bytes(), stderrDiagnosticTruncated: false }, 'GIT_COMMAND_TIMEOUT'],
    [{ termination: 'cancelled', exitCode: null, stdout: bytes(), stderrDiagnostic: bytes(), stderrDiagnosticTruncated: false }, 'GIT_COMMAND_CANCELLED'],
    [{ termination: 'output_limit', exitCode: null, stdout: bytes(), stderrDiagnostic: bytes(), stderrDiagnosticTruncated: false }, 'GIT_OUTPUT_LIMIT_EXCEEDED'],
    [{ termination: 'spawn_failed', exitCode: null, spawnFailure: 'not_found', stdout: bytes(), stderrDiagnostic: bytes(), stderrDiagnosticTruncated: false }, 'GIT_EXECUTABLE_UNAVAILABLE'],
  ];
  for (const [commandResult, expectedCode] of cases) {
    const result = classifyRepositoryDiscoveryResultV1(commandResult);
    assert.equal(result.observationState, 'UNAVAILABLE');
    assert.equal(result.error?.code, expectedCode);
  }
});

test('L1C-M1-10 successful repository discovery requires an absolute root', () => {
  assert.deepEqual(classifyRepositoryDiscoveryResultV1(exited(0, 'C:/repo\n')), {
    observationState: 'GIT',
    repositoryRoot: 'C:/repo',
    error: null,
  });
  const malformed = classifyRepositoryDiscoveryResultV1(exited(0, 'relative/repo\n'));
  assert.equal(malformed.observationState, 'UNAVAILABLE');
  assert.equal(malformed.error?.code, 'GIT_REPOSITORY_ROOT_INVALID');
});

test('L1C-M1-R03 repository root output is one valid UTF-8 absolute record', () => {
  for (const stdout of [
    'C:/repo\nextra',
    'C:/repo\r\nextra',
    'C:/repo\0extra',
    'C:/repo\t\n',
    '',
  ]) {
    const result = classifyRepositoryDiscoveryResultV1(exited(0, stdout));
    assert.equal(result.observationState, 'UNAVAILABLE', JSON.stringify(stdout));
    if (result.observationState === 'UNAVAILABLE') {
      assert.equal(result.error.code, 'GIT_REPOSITORY_ROOT_INVALID', JSON.stringify(stdout));
    }
  }
  const invalidUtf8 = classifyRepositoryDiscoveryResultV1({
    ...exited(0),
    stdout: Uint8Array.from([0x43, 0x3a, 0x2f, 0x72, 0x65, 0x70, 0xff]),
  });
  assert.equal(invalidUtf8.observationState, 'UNAVAILABLE');
  if (invalidUtf8.observationState === 'UNAVAILABLE') {
    assert.equal(invalidUtf8.error.code, 'GIT_REPOSITORY_ROOT_INVALID');
  }
});

test('L1C-M1-R04 HEAD classifier distinguishes valid, exact unborn and unavailable results', () => {
  const unbornDiagnostic =
    "fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree.\n"
    + "Use '--' to separate paths from revisions, like this:\n"
    + "'git <command> [<revision>...] -- [<file>...]'";
  assert.equal(GIT_C_LOCALE_UNBORN_HEAD_DIAGNOSTIC_V1, unbornDiagnostic);

  const valid = classifyHeadCommitResultV1(exited(0, `${'a'.repeat(40)}\n`));
  assert.deepEqual(valid, { state: 'available', commitSha: commitId('a'.repeat(40)) });

  const classifiedSnapshot = classifyGitObservationV1({
    trigger: 'on_demand',
    cwd: 'C:/workspace',
    repository: { observationState: 'GIT', repositoryRoot: 'C:/workspace', error: null },
    status: completeStatus([]),
    head: valid,
    diff: { diffState: 'not_requested', subfailure: null },
  });
  assert.equal(classifiedSnapshot.observationState, 'GIT');
  assert.equal(classifiedSnapshot.baseCommitSha, commitId('a'.repeat(40)));
  assert.equal(classifiedSnapshot.finalCommitSha, commitId('a'.repeat(40)));

  const unborn = classifyHeadCommitResultV1(exited(128, '', `${unbornDiagnostic}\n`));
  assert.deepEqual(unborn, { state: 'unborn' });

  const unknown128 = classifyHeadCommitResultV1(exited(128, '', 'fatal: malformed object database\n'));
  assert.equal(unknown128.state, 'unavailable');
  if (unknown128.state === 'unavailable') assert.equal(unknown128.error.code, 'GIT_HEAD_UNAVAILABLE');

  const malformedSha = classifyHeadCommitResultV1(exited(0, 'HEAD\n'));
  assert.equal(malformedSha.state, 'unavailable');
  if (malformedSha.state === 'unavailable') assert.equal(malformedSha.error.code, 'GIT_HEAD_OUTPUT_INVALID');

  for (const commandResult of [
    { termination: 'timed_out' as const, exitCode: null, stdout: bytes(), stderrDiagnostic: bytes(), stderrDiagnosticTruncated: false },
    { termination: 'cancelled' as const, exitCode: null, stdout: bytes(), stderrDiagnostic: bytes(), stderrDiagnosticTruncated: false },
    { termination: 'output_limit' as const, exitCode: null, stdout: bytes(), stderrDiagnostic: bytes(), stderrDiagnosticTruncated: false },
  ]) {
    const result = classifyHeadCommitResultV1(commandResult);
    assert.equal(result.state, 'unavailable');
    if (result.state === 'unavailable') assert.equal(result.error.code, commandResult.termination === 'timed_out'
      ? 'GIT_COMMAND_TIMEOUT'
      : commandResult.termination === 'cancelled'
        ? 'GIT_COMMAND_CANCELLED'
        : 'GIT_OUTPUT_LIMIT_EXCEEDED');
  }
});

test('L1C-M1-R06 commit object IDs accept only lowercase 40/64 hex', () => {
  assert.equal(parseGitCommitObjectIdV1('a'.repeat(40)), commitId('a'.repeat(40)));
  assert.equal(parseGitCommitObjectIdV1('b'.repeat(64)), commitId('b'.repeat(64)));
  for (const invalid of [
    '--output=C:/workspace/file',
    '--stat',
    'HEAD',
    'a'.repeat(40) + ' ',
    `a${'a'.repeat(38)}\n`,
    `a${'a'.repeat(38)}\0`,
    'a'.repeat(39),
    'a'.repeat(41),
    'a'.repeat(63),
    'a'.repeat(65),
    'g'.repeat(40),
    'A'.repeat(40),
  ]) {
    assert.equal(parseGitCommitObjectIdV1(invalid), null, invalid);
  }
});

test('L1C-M1-11 complete status maps zero entries to clean and entries to dirty', () => {
  assert.equal(classifyDirtyStateV1(completeStatus([])), 'clean');
  assert.equal(classifyDirtyStateV1(completeStatus([trackedFile])), 'dirty');
});

test('L1C-M1-12 incomplete status is never clean', () => {
  const incomplete: GitObservationStatusResultV1 = {
    ok: false,
    statusCompleteness: 'incomplete',
    changedFiles: null,
    error: { phase: 'status', code: 'GIT_STATUS_PARSE_FAILED' },
  };
  assert.equal(classifyDirtyStateV1(incomplete), 'unknown');
});

test('L1C-M1-13 NOT_GIT has public not-applicable dirty state and Event unknown mapping', () => {
  const snapshot = classifyGitObservationV1({
    trigger: 'on_demand',
    cwd: 'C:/workspace',
    repository: { observationState: 'NOT_GIT', repositoryRoot: null, error: null },
  });
  assert.equal(snapshot.observationState, 'NOT_GIT');
  assert.equal(snapshot.dirtyState, 'not_applicable');
  assert.equal(mapGitObservationEventDirtyStateV1(snapshot), 'unknown');
});

test('L1C-M1-13b snapshot union rejects contradictory state combinations', () => {
  // @ts-expect-error NOT_GIT cannot claim a clean Git status
  const falseClean: GitObservationSnapshotV1 = {
    schemaVersion: 1,
    trigger: 'on_demand',
    observationState: 'NOT_GIT',
    repositoryRoot: null,
    cwd: 'C:/workspace',
    baseCommitSha: null,
    finalCommitSha: null,
    dirtyState: 'clean',
    statusCompleteness: 'not_applicable',
    changedFiles: null,
    diffState: 'not_applicable',
    truncation: { changedFiles: false, diff: false },
    error: null,
    subfailures: [],
  };
  // @ts-expect-error UNAVAILABLE must carry a stable top-level error
  const missingError: GitObservationSnapshotV1 = {
    schemaVersion: 1,
    trigger: 'terminal',
    observationState: 'UNAVAILABLE',
    repositoryRoot: null,
    cwd: 'C:/workspace',
    baseCommitSha: null,
    finalCommitSha: null,
    dirtyState: 'unknown',
    statusCompleteness: 'incomplete',
    changedFiles: null,
    diffState: 'unavailable',
    truncation: { changedFiles: false, diff: false },
    error: null,
    subfailures: [],
  };
  void falseClean;
  void missingError;
});

test('L1C-M1-14 malformed status fails the whole observation closed', () => {
  const snapshot = classifyGitObservationV1({
    trigger: 'terminal',
    cwd: 'C:/workspace',
    repository: { observationState: 'GIT', repositoryRoot: 'C:/workspace', error: null },
    status: {
      ok: false,
      statusCompleteness: 'incomplete',
      changedFiles: null,
      error: { phase: 'status', code: 'GIT_STATUS_PARSE_FAILED' },
    },
    head: { state: 'available', baseCommitSha: commitId('a'.repeat(40)), finalCommitSha: commitId('b'.repeat(40)) },
    diff: { diffState: 'not_requested', subfailure: null },
  });
  assert.equal(snapshot.observationState, 'UNAVAILABLE');
  assert.equal(snapshot.dirtyState, 'unknown');
  assert.equal(snapshot.statusCompleteness, 'incomplete');
});

test('L1C-M1-15 diff failure preserves successful GIT status facts', () => {
  const diff = classifyDiffResultV1({ kind: 'command', result: exited(1, '', 'fatal: diff failed\n') });
  const snapshot = classifyGitObservationV1({
    trigger: 'terminal',
    cwd: 'C:/workspace',
    repository: { observationState: 'GIT', repositoryRoot: 'C:/workspace', error: null },
    status: completeStatus([trackedFile]),
    head: { state: 'available', baseCommitSha: commitId('a'.repeat(40)), finalCommitSha: commitId('b'.repeat(40)) },
    diff,
  });
  assert.equal(snapshot.observationState, 'GIT');
  assert.equal(snapshot.dirtyState, 'dirty');
  assert.equal(snapshot.diffState, 'unavailable');
  assert.deepEqual(snapshot.subfailures, [{ phase: 'diff', code: 'GIT_DIFF_UNAVAILABLE' }]);
});

test('L1C-M1-16 truncated diff is explicit and never equivalent to no changes', () => {
  const diff = classifyDiffResultV1({
    kind: 'command',
    result: { termination: 'output_limit', exitCode: null, stdout: bytes('partial'), stderrDiagnostic: bytes(), stderrDiagnosticTruncated: false },
  });
  assert.equal(diff.diffState, 'truncated');
  assert.equal(diff.subfailure?.code, 'GIT_DIFF_TRUNCATED');
});

test('L1C-M1-17 unborn repository remains GIT with null commits and non-applicable diff', () => {
  const snapshot = classifyGitObservationV1({
    trigger: 'on_demand',
    cwd: 'C:/workspace',
    repository: { observationState: 'GIT', repositoryRoot: 'C:/workspace', error: null },
    status: completeStatus([trackedFile]),
    head: { state: 'unborn' },
    diff: { diffState: 'not_requested', subfailure: null },
  });
  assert.equal(snapshot.observationState, 'GIT');
  assert.equal(snapshot.baseCommitSha, null);
  assert.equal(snapshot.finalCommitSha, null);
  assert.equal(snapshot.diffState, 'not_applicable');
  assert.equal(snapshot.dirtyState, 'dirty');

  // @ts-expect-error unborn repositories cannot claim an available commit-based diff
  const impossibleAvailableDiff: ClassifyGitObservationInputV1 = {
    trigger: 'on_demand',
    cwd: 'C:/workspace',
    repository: { observationState: 'GIT', repositoryRoot: 'C:/workspace', error: null },
    status: completeStatus([trackedFile]),
    head: { state: 'unborn' },
    diff: { diffState: 'available', subfailure: null },
  };
  void impossibleAvailableDiff;
});

test('L1C-M1-18 snapshot serialization is deterministic across subfailure order', () => {
  const base: GitObservationSnapshotV1 = {
    schemaVersion: 1,
    trigger: 'terminal',
    observationState: 'GIT',
    repositoryRoot: 'C:/workspace',
    cwd: 'C:/workspace',
    baseCommitSha: commitId('a'.repeat(40)),
    finalCommitSha: commitId('b'.repeat(40)),
    dirtyState: 'dirty',
    statusCompleteness: 'complete',
    changedFiles: createChangedFilesV1([trackedFile]),
    diffState: 'unavailable',
    truncation: { changedFiles: false, diff: false },
    error: null,
    subfailures: [
      { phase: 'diff', code: 'GIT_DIFF_UNAVAILABLE' },
      { phase: 'head', code: 'GIT_HEAD_UNAVAILABLE' },
    ],
  };
  assert.equal(
    serializeGitObservationSnapshotV1(base),
    serializeGitObservationSnapshotV1({ ...base, subfailures: [...base.subfailures].reverse() }),
  );
});

test('L1C-M1-19 Event source and canonical causal-context seam are frozen', () => {
  assert.deepEqual(GIT_OBSERVATION_EVENT_SOURCES_V1, {
    observationCompleted: 'git-runtime',
    observationUnavailable: 'git-runtime',
    diffRegistered: 'artifact-manager',
  });
  const workspaceOnly: GitObservationEventBindingV1 = { subjectKind: 'WORKSPACE_ONLY' };
  const legacy: GitObservationEventBindingV1 = {
    subjectKind: 'LEGACY_AGENT_RUN',
    legacyRunId: 'legacy-1',
  };
  assert.equal(canEmitCanonicalGitObservationEventV1(workspaceOnly), false);
  assert.equal(canEmitCanonicalGitObservationEventV1(legacy), false);

  const plainContext: RuntimeEventContext = { correlationId: 'corr-1', causationId: 'cause-1' };
  const fakeCanonical: GitObservationEventBindingV1 = {
    subjectKind: 'CANONICAL_RUN',
    canonicalRunId: 'run-1',
    // @ts-expect-error caller-provided plain/synthetic context lacks causal authority
    runtimeEventContext: plainContext,
  };
  void fakeCanonical;

  function bindingFromAuthority(
    authority: GitObservationRuntimeEventContextAuthorityV1,
    source: RuntimeEventContextAuthoritySourceV1,
  ): GitObservationEventBindingV1 {
    return {
      subjectKind: 'CANONICAL_RUN',
      canonicalRunId: 'run-1',
      runtimeEventContext: authority.authorize(source),
    };
  }
  // This compile-time seam is the only documented positive construction path.
  void bindingFromAuthority;
});

test('L1C-M1-20 canonical diff Artifact crash ordering forbids DB-first availability', () => {
  assert.deepEqual(CANONICAL_DIFF_ARTIFACT_COMMIT_ORDER_V1, [
    'collect_bytes',
    'validate_hash_and_size',
    'write_temporary_file',
    'rename_to_final_immutable_path',
    'begin_database_transaction',
    'insert_canonical_artifact',
    'insert_git_observation',
    'append_runtime_events',
    'insert_one_outbox_per_event',
    'commit_database_transaction',
  ]);
  assert.deepEqual(CANONICAL_DIFF_ARTIFACT_CRASH_POLICY_V1, {
    failureBeforeCommit: 'rollback_and_remove_staged_and_final_artifact_directory',
    crashBeforeDatabaseCommit: 'orphan_file_allowed',
    crashAfterDatabaseCommit: 'database_never_points_to_missing_final_content',
  });
  assert.equal(canCommitCanonicalDiffArtifactV1({ contentAvailable: true, immutableFinalContentExists: false }), false);
  assert.equal(canCommitCanonicalDiffArtifactV1({ contentAvailable: true, immutableFinalContentExists: true }), true);
  assert.equal(canCommitCanonicalDiffArtifactV1({ contentAvailable: false, immutableFinalContentExists: false }), true);
});
