import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const MAX_GIT_BUFFER_BYTES = 32 * 1024 * 1024;
const ATTRIBUTE_NAMES = ['text', 'eol', 'crlf', 'ident', 'working-tree-encoding', 'filter', 'diff'] as const;
const NORMALIZATION_CONFIG = [
  'core.autocrlf', 'core.eol', 'core.safecrlf', 'core.filemode',
  'core.ignorecase', 'core.checkroundtripencoding', 'core.bigfilethreshold',
] as const;
const BOOLEAN_CONFIG = new Set(['core.autocrlf', 'core.safecrlf', 'core.filemode', 'core.ignorecase']);
const METADATA_COMMANDS = new Set(['rev-parse', 'config', 'ls-tree', 'ls-files', 'check-attr']);

function gitEnvironment(sourceMetadata = false): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Bind every invocation to its explicit repository/index. Inherited Git
  // environment can otherwise redirect the repository or inject config. The
  // source may read effective config/attributes from the environment, but no
  // content command inherits them; only selected frozen values are copied.
  for (const key of Object.keys(env)) {
    const name = key.toUpperCase();
    const configInput = /^GIT_CONFIG_(?:GLOBAL|SYSTEM|NOSYSTEM|COUNT|PARAMETERS|KEY_\d+|VALUE_\d+)$/u.test(name)
      || name === 'GIT_ATTR_NOSYSTEM';
    if (name.startsWith('GIT_') && !(sourceMetadata && configInput)) delete env[key];
  }
  return { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' };
}

async function executeGit(
  cwd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  input?: Buffer,
): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('git', [...args], { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    const timeout = setTimeout(() => {
      failure = new Error('COLLABORATION_GIT_TIMEOUT: Git command exceeded the snapshot deadline');
      child.kill();
    }, 30_000);
    const collect = (chunks: Buffer[], chunk: Buffer): void => {
      bytes += chunk.byteLength;
      if (bytes > MAX_GIT_BUFFER_BYTES) {
        failure ??= new Error('COLLABORATION_GIT_OUTPUT_TOO_LARGE: Git output exceeds the safe limit');
        child.kill();
      } else {
        chunks.push(chunk);
      }
    };
    child.stdout.on('data', chunk => collect(stdout, Buffer.from(chunk)));
    child.stderr.on('data', chunk => collect(stderr, Buffer.from(chunk)));
    child.on('error', error => { failure ??= error; });
    child.stdin.on('error', error => {
      if ((error as NodeJS.ErrnoException).code !== 'EPIPE') failure ??= error;
    });
    child.on('close', code => {
      clearTimeout(timeout);
      if (failure) rejectPromise(failure);
      else if (code !== 0) rejectPromise(new Error(`COLLABORATION_GIT_COMMAND_FAILED: Git exited ${code}\n${Buffer.concat(stderr).toString('utf8')}`));
      else resolvePromise(Buffer.concat(stdout));
    });
    child.stdin.end(input);
  });
}

function parseConfig(output: Buffer): Map<string, string | null> {
  const values = new Map<string, string | null>();
  for (const record of output.toString('utf8').split('\0').filter(Boolean)) {
    const separator = record.indexOf('\n');
    // Git distinguishes a valueless boolean (true) from an explicit empty
    // value (false). Keep that distinction until the known key is interpreted.
    values.set(separator < 0 ? record : record.slice(0, separator), separator < 0 ? null : record.slice(separator + 1));
  }
  return values;
}

function quoteAttributePattern(path: string): string {
  const literalPattern = path.replace(/([*?\[\]\\])/gu, '\\$1');
  let quoted = '"';
  for (const byte of Buffer.from(literalPattern, 'utf8')) {
    if (byte === 34 || byte === 92) quoted += `\\${String.fromCharCode(byte)}`;
    else if (byte < 32 || byte >= 127) quoted += `\\${byte.toString(8).padStart(3, '0')}`;
    else quoted += String.fromCharCode(byte);
  }
  return `${quoted}"`;
}

function attributeToken(name: string, value: string): string {
  if (value === 'unspecified') return `!${name}`;
  if (value === 'unset') return `-${name}`;
  if (value === 'set') return name;
  if (!value || /[\s\0]/u.test(value)) {
    throw new Error('COLLABORATION_GIT_ATTRIBUTE_UNSUPPORTED: attribute value cannot be frozen safely');
  }
  return `${name}=${value}`;
}

/**
 * Only metadata queries use the source repository. Every content operation
 * runs in an owned Git directory/shadow worktree with frozen normalization
 * config and per-path attributes, without any source filter/process/smudge,
 * external diff, hooks, or global/system attributes configuration.
 */
export class CollaborationSnapshotGitContext {
  private frozenAttributePaths: readonly string[] = [];
  private frozenAttributes: Buffer = Buffer.alloc(0);
  private checkoutAttributes = false;

  private constructor(
    readonly sourceRoot: string,
    private readonly sourceGitDirectory: string,
    private readonly sourceEnv: NodeJS.ProcessEnv,
    private readonly frozenConfig: Buffer,
    private readonly config: ReadonlyMap<string, string | null>,
    private readonly temporaryDirectory: string,
    private readonly gitDirectory: string,
    private readonly shadowWorktree: string,
    private readonly privateEnv: NodeJS.ProcessEnv,
  ) {}

  static async create(sourceRoot: string): Promise<CollaborationSnapshotGitContext> {
    const sourceEnv = gitEnvironment(true);
    const sourceGitDirectory = (await executeGit(sourceRoot, [
      '--no-pager', '-c', 'core.fsmonitor=false', 'rev-parse', '--absolute-git-dir',
    ], sourceEnv)).toString('utf8').trim();
    const sourceArgs = ['--no-pager', `--git-dir=${sourceGitDirectory}`, `--work-tree=${sourceRoot}`,
      '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false'];
    const frozenConfig = await executeGit(sourceRoot, [...sourceArgs, 'config', '--null', '--list', '--includes'], sourceEnv);
    const config = parseConfig(frozenConfig);
    const objectFormat = (await executeGit(sourceRoot, [...sourceArgs, 'rev-parse', '--show-object-format'], sourceEnv)).toString('utf8').trim();
    if (objectFormat !== 'sha1' && objectFormat !== 'sha256') {
      throw new Error('COLLABORATION_GIT_ATTRIBUTE_UNSUPPORTED: unsupported Git object format');
    }
    const objects = (await executeGit(sourceRoot, [...sourceArgs, 'rev-parse', '--path-format=absolute', '--git-path', 'objects'], sourceEnv)).toString('utf8').trim();
    if (/[\r\n]/u.test(objects)) throw new Error('COLLABORATION_GIT_ATTRIBUTE_UNSUPPORTED: object store path cannot be isolated safely');

    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'agentos-snapshot-git-'));
    try {
      const gitDirectory = join(temporaryDirectory, 'repository');
      const shadowWorktree = join(temporaryDirectory, 'worktree');
      const emptyConfig = join(temporaryDirectory, 'empty-config');
      await mkdir(shadowWorktree);
      await writeFile(emptyConfig, '');
      const privateEnv = {
        ...gitEnvironment(), GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_SYSTEM: emptyConfig,
        GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1',
      };
      await executeGit(temporaryDirectory, ['init', '--quiet', '--bare', '--template=', `--object-format=${objectFormat}`, gitDirectory], privateEnv);
      await mkdir(join(gitDirectory, 'objects', 'info'), { recursive: true });
      await mkdir(join(gitDirectory, 'info'), { recursive: true });
      await writeFile(join(gitDirectory, 'objects', 'info', 'alternates'), `${objects.replaceAll('\\', '/')}\n`);
      const context = new CollaborationSnapshotGitContext(sourceRoot, sourceGitDirectory, sourceEnv, frozenConfig, config,
        temporaryDirectory, gitDirectory, shadowWorktree, privateEnv);
      for (const [key, value] of [
        ['core.bare', 'false'], ['core.attributesfile', emptyConfig], ['core.fsmonitor', 'false'],
        ...(process.platform === 'win32' ? [['core.longpaths', 'true']] : []),
        ['core.untrackedcache', 'false'], ['core.hookspath', join(temporaryDirectory, 'empty-hooks')],
      ]) await context.run(['config', key, value]);
      for (const key of NORMALIZATION_CONFIG) {
        const value = config.get(key);
        if (value !== undefined) {
          if (value === null && !BOOLEAN_CONFIG.has(key)) {
            throw new Error(`COLLABORATION_GIT_ATTRIBUTE_UNSUPPORTED: valueless normalization config cannot be frozen safely (${key})`);
          }
          await context.run(['config', key, value ?? 'true']);
        }
      }
      return context;
    } catch (error) {
      await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      throw error;
    }
  }

  async sourceMetadata(args: readonly string[], input?: Buffer): Promise<Buffer> {
    if (!METADATA_COMMANDS.has(args[0])) throw new Error('COLLABORATION_GIT_CONTEXT_INVALID: source content commands are prohibited');
    return executeGit(this.sourceRoot, [
      '--no-pager', `--git-dir=${this.sourceGitDirectory}`, `--work-tree=${this.sourceRoot}`,
      '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args,
    ], this.sourceEnv, input);
  }

  async run(args: readonly string[], input?: Buffer): Promise<Buffer> {
    return executeGit(this.shadowWorktree, [
      '--no-pager', `--git-dir=${this.gitDirectory}`, `--work-tree=${this.shadowWorktree}`, ...args,
    ], this.privateEnv, input);
  }

  private async sourceAttributes(): Promise<Buffer> {
    if (this.frozenAttributePaths.length === 0) return Buffer.alloc(0);
    if (this.checkoutAttributes) {
      // Read post-materialization attributes from our patched index, not the
      // live source .gitattributes. Source info/global attributes are metadata
      // only; their effective values are frozen into our private info file.
      return executeGit(this.sourceRoot, [
        '--no-pager', `--git-dir=${this.sourceGitDirectory}`, `--work-tree=${this.sourceRoot}`,
        '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
        'check-attr', '--cached', '-z', ...ATTRIBUTE_NAMES, '--stdin',
      ], { ...this.sourceEnv, GIT_INDEX_FILE: join(this.gitDirectory, 'index'),
        GIT_OBJECT_DIRECTORY: join(this.gitDirectory, 'objects') },
      Buffer.from(`${this.frozenAttributePaths.join('\0')}\0`, 'utf8'));
    }
    return this.sourceMetadata(['check-attr', '-z', ...ATTRIBUTE_NAMES, '--stdin'],
      Buffer.from(`${this.frozenAttributePaths.join('\0')}\0`, 'utf8'));
  }

  async freezeAttributes(paths: readonly string[]): Promise<void> {
    this.checkoutAttributes = false;
    await this.freezeEffectiveAttributes(paths);
  }

  /** Freeze checkout/clean semantics from the current private index tree. */
  async freezeCheckoutAttributes(paths: readonly string[]): Promise<void> {
    for (const record of (await this.run(['ls-files', '-s', '-z'])).toString('utf8').split('\0').filter(Boolean)) {
      const tab = record.indexOf('\t');
      const path = record.slice(tab + 1);
      if (path.split('/').at(-1)?.toLowerCase() === '.gitattributes'
        && !['100644', '100755'].includes(record.slice(0, tab).split(' ')[0])) {
        throw new Error('COLLABORATION_GIT_ATTRIBUTE_UNSUPPORTED: linked/submodule attributes cannot be materialized safely');
      }
    }
    this.checkoutAttributes = true;
    await this.freezeEffectiveAttributes(paths);
  }

  private async freezeEffectiveAttributes(paths: readonly string[]): Promise<void> {
    this.frozenAttributePaths = [...new Set(paths)].sort();
    this.frozenAttributes = await this.sourceAttributes();
    const fields = this.frozenAttributes.toString('utf8').split('\0');
    if (fields.at(-1) === '') fields.pop();
    if (fields.length !== this.frozenAttributePaths.length * ATTRIBUTE_NAMES.length * 3) {
      throw new Error('COLLABORATION_GIT_ATTRIBUTE_UNSUPPORTED: malformed Git attribute output');
    }
    const attributes = new Map<string, Map<string, string>>();
    for (let index = 0; index < fields.length; index += 3) {
      const [path, name, value] = fields.slice(index, index + 3);
      if (!this.frozenAttributePaths.includes(path) || !ATTRIBUTE_NAMES.includes(name as typeof ATTRIBUTE_NAMES[number])) {
        throw new Error('COLLABORATION_GIT_ATTRIBUTE_UNSUPPORTED: unexpected Git attribute output');
      }
      const row = attributes.get(path) ?? new Map<string, string>();
      if (row.has(name)) throw new Error('COLLABORATION_GIT_ATTRIBUTE_UNSUPPORTED: duplicate Git attribute output');
      row.set(name, value);
      attributes.set(path, row);
      if (name === 'filter' && value !== 'unspecified' && value !== 'unset') {
        throw new Error(`COLLABORATION_GIT_ATTRIBUTE_UNSUPPORTED: custom clean filters are not supported (${JSON.stringify(path)})`);
      }
      if (name === 'diff' && !['unspecified', 'unset', 'set'].includes(value)) {
        if (!/^[A-Za-z0-9_.-]+$/u.test(value)
          || this.config.has(`diff.${value}.textconv`) || this.config.has(`diff.${value}.command`)) {
          throw new Error(`COLLABORATION_GIT_ATTRIBUTE_UNSUPPORTED: external diff conversion is not supported (${JSON.stringify(path)})`);
        }
        for (const option of ['binary', 'xfuncname', 'funcname']) {
          const key = `diff.${value}.${option}`;
          const configured = this.config.get(key);
          if (configured !== undefined) {
            if (configured === null && option !== 'binary') {
              throw new Error('COLLABORATION_GIT_ATTRIBUTE_UNSUPPORTED: valueless diff configuration cannot be frozen safely');
            }
            await this.run(['config', key, configured ?? 'true']);
          }
        }
      }
    }
    // info/attributes has highest precedence. Explicitly reset every clean
    // attribute even when unspecified, preventing index .gitattributes fallback
    // or copied attribute macros from changing the frozen per-path semantics.
    const lines = this.frozenAttributePaths.map(path => {
      const row = attributes.get(path)!;
      return `${quoteAttributePattern(path)} ${ATTRIBUTE_NAMES.map(name =>
        name === 'filter' ? '-filter' : attributeToken(name, row.get(name)!)).join(' ')}`;
    });
    await writeFile(join(this.gitDirectory, 'info', 'attributes'), `${lines.join('\n')}\n`);
    await this.assertSourceContextUnchanged();
  }

  async assertSourceContextUnchanged(): Promise<void> {
    const config = await this.sourceMetadata(['config', '--null', '--list', '--includes']);
    if (!config.equals(this.frozenConfig)) {
      throw new Error('COLLABORATION_SNAPSHOT_SOURCE_CHANGED: Git configuration changed during candidate capture');
    }
    if (!(await this.sourceAttributes()).equals(this.frozenAttributes)) {
      throw new Error('COLLABORATION_SNAPSHOT_SOURCE_CHANGED: Git attributes changed during candidate capture');
    }
  }

  private frozenPath(path: string): string {
    const segments = path.split('/');
    if (path.includes('\\') || path.includes(':') || segments.some(segment => !segment || segment === '.' || segment === '..' || segment.toLowerCase() === '.git')) {
      throw new Error('COLLABORATION_PATH_BOUNDARY: unsafe frozen source path');
    }
    return resolve(this.shadowWorktree, ...segments);
  }

  async writeFrozenSource(path: string, bytes: Buffer, mode: number): Promise<void> {
    const destination = this.frozenPath(path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
    if (process.platform !== 'win32') await chmod(destination, mode & 0o111 ? 0o755 : 0o644);
  }

  async readFrozenSource(path: string): Promise<Buffer> {
    return readFile(this.frozenPath(path));
  }

  async dispose(): Promise<void> {
    await rm(this.temporaryDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}
