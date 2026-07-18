import type { AgentEvent } from '@agentos/shared';

export interface RuntimeStoragePolicy {
  maxOutputEventsPerRun: number;
  maxDiagnosticEventsPerRun: number;
  maxToolPairsPerRun: number;
  maxArtifactsPerRun: number;
  workspaceArtifactWarningBytes: number;
  automaticRunDeletion: false;
}

export const DEFAULT_RUNTIME_STORAGE_POLICY: RuntimeStoragePolicy = {
  maxOutputEventsPerRun: 5000,
  maxDiagnosticEventsPerRun: 1000,
  maxToolPairsPerRun: 5000,
  maxArtifactsPerRun: 100,
  workspaceArtifactWarningBytes: 5 * 1024 * 1024 * 1024,
  automaticRunDeletion: false,
};

const OUTPUT_FLUSH_MS = 250;
const OUTPUT_FLUSH_CHARS = 4096;

/**
 * Bounds persisted runtime detail without changing the live SSE stream. Output
 * chunks are coalesced only inside this persistence-side buffer.
 */
export class RuntimeEventBuffer {
  private readonly events: AgentEvent[] = [];
  private output = 0;
  private diagnostic = 0;
  private tools = 0;
  private pendingOutput?: AgentEvent;
  private pendingOutputLength = 0;
  private flushTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly policy: RuntimeStoragePolicy = DEFAULT_RUNTIME_STORAGE_POLICY) {}

  push(event: AgentEvent): boolean {
    if (event.type === 'execution.output.appended') {
      if (++this.output > this.policy.maxOutputEventsPerRun) return false;
      const text = typeof event.payload?.text === 'string' ? event.payload.text : '';
      if (this.pendingOutput && this.pendingOutputLength + text.length <= OUTPUT_FLUSH_CHARS) {
        const elapsed = Date.parse(event.timestamp) - Date.parse(this.pendingOutput.timestamp);
        if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < OUTPUT_FLUSH_MS) {
          this.pendingOutput = {
            ...this.pendingOutput,
            payload: { ...this.pendingOutput.payload, text: `${String(this.pendingOutput.payload?.text ?? '')}${text}` },
            timestamp: event.timestamp,
          };
          this.pendingOutputLength += text.length;
          return true;
        }
      }
      this.flushOutput();
      this.pendingOutput = event;
      this.pendingOutputLength = text.length;
      this.scheduleFlush();
      return true;
    }

    this.flushOutput();
    if (event.type === 'execution.diagnostic' && ++this.diagnostic > this.policy.maxDiagnosticEventsPerRun) return false;
    if (event.type === 'execution.tool.started' && ++this.tools > this.policy.maxToolPairsPerRun) return false;
    this.events.push(event);
    return true;
  }

  /** Flushes coalesced output and returns events ready for persistence. */
  drain(): AgentEvent[] {
    this.flushOutput();
    return this.events.splice(0);
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flushOutput();
    }, OUTPUT_FLUSH_MS);
    this.flushTimer.unref?.();
  }

  private flushOutput(): void {
    if (!this.pendingOutput) return;
    this.events.push(this.pendingOutput);
    this.pendingOutput = undefined;
    this.pendingOutputLength = 0;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
  }
}
