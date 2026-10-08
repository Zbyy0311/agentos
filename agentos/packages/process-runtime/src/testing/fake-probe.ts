import type { FileSystemProbe } from '../validation.js';

/** Deterministic in-memory filesystem probe for launch-validation tests. */
export class FakeFileSystemProbe implements FileSystemProbe {
  readonly #files = new Map<string, boolean>();
  readonly #dirs = new Set<string>();

  addExecutable(path: string): this {
    this.#files.set(path, true);
    return this;
  }

  addPlainFile(path: string): this {
    this.#files.set(path, false);
    return this;
  }

  addDirectory(path: string): this {
    this.#dirs.add(path);
    return this;
  }

  exists(path: string): boolean {
    return this.#files.has(path) || this.#dirs.has(path);
  }

  isFile(path: string): boolean {
    return this.#files.has(path);
  }

  isDirectory(path: string): boolean {
    return this.#dirs.has(path);
  }

  isExecutable(path: string): boolean {
    return this.#files.get(path) === true;
  }

  realpath(path: string): string {
    if (!this.exists(path)) throw new Error('no such path: ' + path);
    return path;
  }
}
