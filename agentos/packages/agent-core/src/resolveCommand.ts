import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { isAbsolute, delimiter, join } from 'node:path';

/**
 * Resolve a command against PATH in a cross-platform way.
 * Returns the absolute path to the executable, or null if not found.
 */
export async function resolveCommand(cmd: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (isAbsolute(cmd)) {
    try {
      await access(cmd);
      return cmd;
    } catch {
      return null;
    }
  }

  const platform = process.platform;
  const shellCommand = platform === 'win32' ? 'where.exe' : 'which';

  const found = await new Promise<string | null>((resolve) => {
    let stdout = '';
    let stderr = '';

    const child = spawn(shellCommand, [cmd], {
      shell: false,
      env,
      windowsHide: true,
    });

    child.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on('close', (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      const first = stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0];
      resolve(first ?? null);
    });

    child.on('error', () => resolve(null));
  });

  if (found) return found;

  // Fallback: manual PATH scan if which/where is unavailable
  const pathEnv = env.PATH ?? env.Path ?? '';
  const extensions = platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of pathEnv.split(delimiter)) {
    for (const ext of extensions) {
      const candidate = join(dir, `${cmd}${ext.toLowerCase()}`);
      try {
        await access(candidate);
        return candidate;
      } catch { /* ignore */ }
    }
  }

  return null;
}
