/**
 * S8 / Lite acceptance runner.
 *
 * Executes a reviewed scenario spec against the real repository and records
 * one result per scenario, together with the requirement ids it covers. The
 * runner does not turn a planned, manual, skipped, timed-out, or failed
 * observation into PASS. A scenario is passed only when the raw child result
 * is exit code 0 and the shared capture receipt proves that the invocation and
 * its raw logs were recorded.
 *
 * Usage:
 *   node scripts/verify-lite-acceptance.mjs --spec <spec.json> [--only id,id]
 *     [--results <out.json>] [--timeoutMs <n>] [--dry-run]
 *
 * A scenario is executed only when it names a reviewer-controlled command:
 *   - `existingVerifier`: a path under scripts/ ending in .ps1/.mjs
 *   - `verifyCommand`:    a command starting with an allowlisted prefix
 * Scenarios whose kind is `ui` or `manual` are recorded as manual-required;
 * scenarios whose kind is `skip` are recorded as skipped.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative as relativePath, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CAPTURE_SCRIPT = 'scripts/capture-lite-verification.mjs';
const FORBIDDEN = [
  /\brm\s+-rf\b/i,
  /Remove-Item[^\n]*-Recurse/i,
  /git\s+reset\s+--hard/i,
  /git\s+push/i,
  /gh\s+pr\s+(merge|close)/i,
  /git\s+checkout\s+--\s/i,
];
const ALLOWED_PREFIXES = ['node ', 'pnpm ', 'pwsh ', 'gh run view ', 'gh pr view '];

function arg(name, fallback) {
  const index = process.argv.indexOf('--' + name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith('--') ? true : value;
}

function assertSafe(command) {
  for (const pattern of FORBIDDEN) {
    if (pattern.test(command)) throw new Error('refusing destructive command: ' + command);
  }
  if (!ALLOWED_PREFIXES.some(prefix => command.startsWith(prefix))) {
    throw new Error('refusing command outside the allowlist: ' + command);
  }
}

function splitCommand(command) {
  const tokens = [];
  let token = '';
  let quote = null;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote !== null) {
      if (character === quote) {
        quote = null;
      } else if (character === '\\' && command[index + 1] === quote) {
        token += command[index + 1];
        index += 1;
      } else {
        token += character;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (/\s/.test(character)) {
      if (token.length > 0) {
        tokens.push(token);
        token = '';
      }
    } else if (character === '\\' && (command[index + 1] === '"' || command[index + 1] === "'")) {
      token += command[index + 1];
      index += 1;
    } else {
      token += character;
    }
  }
  if (quote !== null) throw new Error('unclosed quote in verifyCommand: ' + command);
  if (token.length > 0) tokens.push(token);
  if (tokens.length === 0) throw new Error('verifyCommand produced no executable: ' + command);
  return tokens;
}

function reportPath(path) {
  const relative = relativePath(repoRoot, path).replaceAll('\\', '/');
  return relative === '' || (!relative.startsWith('../') && relative !== '..')
    ? relative
    : path;
}

function tailFromLogs(logs) {
  const output = (logs ?? [])
    .filter(log => typeof log?.path === 'string' && existsSync(log.path))
    .map(log => readFileSync(log.path, 'utf8'))
    .join('\n');
  return output.trim().split(/\r?\n/).slice(-40).join('\n');
}

function errorRecord(error) {
  if (error === undefined || error === null) return null;
  return { code: error.code ?? null, message: error.message ?? String(error) };
}

function runCommand(command, timeoutMs, logLabel) {
  assertSafe(command);
  if (!existsSync(join(repoRoot, CAPTURE_SCRIPT))) {
    throw new Error('shared raw verification recorder is missing: ' + CAPTURE_SCRIPT);
  }

  // The shared recorder owns raw stdout/stderr files, SHA-256 values, the
  // baseline, and the child process exit. This runner only consumes its
  // receipt and applies the PASS policy.
  const commandArgs = splitCommand(command);
  const captureCommand = [
    process.execPath,
    CAPTURE_SCRIPT,
    logLabel,
    '--',
    ...commandArgs,
  ];
  const captured = spawnSync(captureCommand[0], captureCommand.slice(1), {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  const captureOutput = (captured.stdout ?? '') + '\n' + (captured.stderr ?? '');
  const timedOut = captured.error?.code === 'ETIMEDOUT'
    || (captured.signal === 'SIGTERM' && captured.status === null);

  let receipt = null;
  let receiptPath = null;
  const receiptLine = captureOutput.split(/\r?\n/).find(line => line.trim().startsWith('{'));
  if (receiptLine !== undefined) {
    try {
      const summary = JSON.parse(receiptLine);
      if (typeof summary.receipt === 'string' && existsSync(summary.receipt)) {
        receiptPath = summary.receipt;
        receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
      }
    } catch {
      // A malformed or missing receipt is evidence failure, never a pass.
    }
  }

  const rawLogs = Array.isArray(receipt?.logs)
    ? receipt.logs.map(log => ({ ...log, path: reportPath(log.path) }))
    : [];
  const rawLogsComplete = rawLogs.length > 0
    && rawLogs.every(log => typeof log.path === 'string' && existsSync(resolve(repoRoot, log.path))
      && createHash('sha256').update(readFileSync(resolve(repoRoot, log.path))).digest('hex') === log.sha256);
  const rawExitCode = receipt?.rawExitCode ?? null;
  const spawnError = receipt?.error ?? errorRecord(captured.error);
  return {
    // Keep both names: exitCode is the historical report field, while
    // rawExitCode makes it explicit that no normalization occurred.
    exitCode: rawExitCode,
    rawExitCode,
    signal: receipt?.signal ?? captured.signal ?? null,
    spawnError,
    timedOut,
    captureExitCode: captured.status ?? null,
    captureReceiptPath: receiptPath === null ? null : reportPath(receiptPath),
    captureReceipt: receipt,
    baseline: receipt?.baseline ?? null,
    rawLogs,
    rawLogsComplete,
    trackedCheckoutUnchanged: receipt?.trackedCheckoutUnchanged ?? null,
    outputTail: tailFromLogs(receipt?.logs),
    captureOutputTail: captureOutput.trim().split(/\r?\n/).slice(-18).join('\n'),
  };
}

function commandFor(scenario) {
  if (typeof scenario.existingVerifier === 'string') {
    const requested = scenario.existingVerifier.replace(/\\/g, '/');
    const absolute = resolve(repoRoot, requested);
    const relative = relativePath(repoRoot, absolute).replaceAll('\\', '/');
    if (!relative.startsWith('scripts/') || !/\.(ps1|mjs)$/i.test(relative)) {
      throw new Error('existingVerifier must be a script under scripts/: ' + requested);
    }
    if (!existsSync(absolute)) {
      throw new Error('existingVerifier does not exist: ' + relative);
    }
    return relative.toLowerCase().endsWith('.mjs')
      ? 'node ' + relative
      : 'pwsh -NoProfile -ExecutionPolicy Bypass -File ' + relative;
  }
  if (typeof scenario.verifyCommand === 'string' && scenario.verifyCommand.trim().length > 0) {
    return scenario.verifyCommand.trim();
  }
  return undefined;
}

function resultBase(scenario, requirementIds) {
  return {
    id: scenario.id,
    title: scenario.title,
    kind: scenario.kind,
    requirementIds,
  };
}

function main() {
  const specPath = arg('spec');
  if (typeof specPath !== 'string') {
    console.error('usage: node scripts/verify-lite-acceptance.mjs --spec <spec.json> [--only id,id] [--dry-run]');
    return 2;
  }

  try {
    const spec = JSON.parse(readFileSync(resolve(repoRoot, specPath), 'utf8'));
    if (!Array.isArray(spec.scenarios)) throw new Error('spec.scenarios must be an array');
    const onlyValue = arg('only', undefined);
    const only = typeof onlyValue === 'string'
      ? onlyValue.split(',').map(s => s.trim()).filter(Boolean)
      : undefined;
    const dryRun = arg('dry-run', false) === true;
    const timeoutMs = Number(arg('timeoutMs', 1_800_000));
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be a positive number');
    const resultsValue = arg('results', undefined);
    const resultsPath = typeof resultsValue === 'string'
      ? resultsValue
      : 'docs/implementation/lite-closeout/acceptance-results.json';
    const resultsFile = isAbsolute(resultsPath) ? resultsPath : join(repoRoot, resultsPath);
    mkdirSync(dirname(resultsFile), { recursive: true });

    const results = [];
    let executed = 0;
    let passed = 0;
    let failed = 0;
    let manual = 0;
    let skipped = 0;
    const covered = new Set();

    spec.scenarios.forEach((scenario, index) => {
      if (only !== undefined && !only.includes(scenario.id)) return;
      const requirementIds = Array.isArray(scenario.requirementIds) ? scenario.requirementIds : [];
      for (const id of requirementIds) covered.add(id);
      const base = resultBase(scenario, requirementIds);

      if (scenario.kind === 'ui' || scenario.kind === 'manual') {
        results.push({
          ...base,
          status: 'manual-required',
          reason: scenario.preconditions ?? 'needs an interactive or browser run',
        });
        manual += 1;
        return;
      }
      if (scenario.kind === 'skip' || scenario.skip === true) {
        results.push({
          ...base,
          status: 'skipped',
          reason: scenario.reason ?? scenario.preconditions ?? 'scenario was explicitly skipped',
        });
        skipped += 1;
        return;
      }

      let command;
      try {
        command = commandFor(scenario);
      } catch (error) {
        results.push({ ...base, status: 'invalid', reason: error instanceof Error ? error.message : String(error) });
        failed += 1;
        return;
      }
      if (command === undefined) {
        results.push({ ...base, status: 'manual-required', reason: 'no reviewer-controlled command was attached' });
        manual += 1;
        return;
      }
      if (dryRun) {
        results.push({ ...base, status: 'planned', command });
        return;
      }

      const safeId = String(scenario.id ?? `scenario-${index + 1}`).toLowerCase().replace(/[^a-z0-9-]+/g, '-') || `scenario-${index + 1}`;
      const outcome = runCommand(command, timeoutMs, `${String(index + 1).padStart(3, '0')}-${safeId}`);
      const status = outcome.timedOut
        ? 'timed-out'
        : outcome.rawExitCode === 0
          && outcome.spawnError === null
          && outcome.captureReceipt !== null
          && outcome.rawLogsComplete
          && outcome.trackedCheckoutUnchanged === true
          && outcome.captureExitCode === 0
          && outcome.captureReceipt.counts?.passed > 0
          && outcome.captureReceipt.counts?.failed === 0
          && outcome.captureReceipt.counts?.skipped === 0
          && outcome.captureReceipt.counts?.cancelled === 0
          && outcome.captureReceipt.counts?.todo === 0
          ? 'passed'
          : 'failed';
      if (status === 'passed') passed += 1; else failed += 1;
      executed += 1;
      results.push({ ...base, status, command, ...outcome });
      console.log(
        status.padEnd(12) + scenario.id
          + '  rawExit=' + String(outcome.rawExitCode)
          + '  ' + requirementIds.length + ' requirement(s)',
      );
    });

    const verdict = dryRun
      ? 'planned'
      : executed > 0 && passed > 0 && failed === 0 && manual === 0 && skipped === 0
        ? 'passed'
        : 'not-passed';
    const report = {
      schemaVersion: 2,
      spec: specPath,
      specVersion: spec.specVersion ?? null,
      generatedAt: new Date().toISOString(),
      dryRun,
      verdict,
      summary: {
        scenarios: results.length,
        executed,
        passed,
        failed,
        manualRequired: manual,
        skipped,
        requirementsCovered: 0,
        requirementsReferenced: covered.size,
      },
      results,
    };
    writeFileSync(resultsFile, JSON.stringify(report, null, 2) + '\n');
    console.log('spec=' + specPath + ' results=' + resultsFile);
    console.log(
      'verdict=' + verdict
        + ' executed=' + executed
        + ' passed=' + passed
        + ' failed=' + failed
        + ' manual=' + manual
        + ' skipped=' + skipped
        + ' requirements=' + covered.size,
    );
    // A dry run is a successful planning operation, but its report is never a
    // PASS. Every non-dry-run report must prove at least one clean execution
    // and must contain no manual or skipped scenario.
    return dryRun || verdict === 'passed' ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

process.exitCode = main();
