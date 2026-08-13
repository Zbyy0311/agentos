import { ProcessError } from './errors.js';
import type { NativeProcessHandle } from './driver.js';
import type { ProcessId } from './types.js';

/**
 * Memory-only binding between AgentOS Process IDs and live native handles.
 * A handle enters the registry only after native start; it is removed after
 * the terminal commit. PID alone is never ownership: registering a PID that
 * is already bound to a different Process is a PID-reuse registration
 * failure, never a silent rebind.
 */
export class ProcessHandleRegistry {
  readonly #byProcess = new Map<ProcessId, NativeProcessHandle>();
  readonly #byPid = new Map<number, ProcessId>();

  register(processId: ProcessId, handle: NativeProcessHandle): void {
    if (this.#byProcess.has(processId)) {
      throw new ProcessError(
        'PROCESS_REGISTRATION_FAILED',
        'process already has a registered native handle',
      );
    }
    const bound = this.#byPid.get(handle.pid);
    if (bound !== undefined && bound !== processId) {
      throw new ProcessError(
        'PROCESS_REGISTRATION_FAILED',
        'native pid is already bound to a different process',
      );
    }
    this.#byProcess.set(processId, handle);
    this.#byPid.set(handle.pid, processId);
  }

  get(processId: ProcessId): NativeProcessHandle | undefined {
    return this.#byProcess.get(processId);
  }

  getByPid(pid: number): NativeProcessHandle | undefined {
    const processId = this.#byPid.get(pid);
    return processId === undefined ? undefined : this.#byProcess.get(processId);
  }

  ownerOf(pid: number): ProcessId | undefined {
    return this.#byPid.get(pid);
  }

  remove(processId: ProcessId): NativeProcessHandle | undefined {
    const handle = this.#byProcess.get(processId);
    if (handle === undefined) return undefined;
    this.#byProcess.delete(processId);
    if (this.#byPid.get(handle.pid) === processId) {
      this.#byPid.delete(handle.pid);
    }
    return handle;
  }

  get size(): number {
    return this.#byProcess.size;
  }
}
