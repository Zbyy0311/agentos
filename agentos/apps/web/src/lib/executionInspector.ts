import type { AgentEvent, ExecutionEvent, ExecutionStatus } from '@agentos/shared';

export type InspectorExecutionEvent = Pick<ExecutionEvent, 'status' | 'createdAt'>;

export interface ToolHistoryItem {
  id: string;
  toolName: string;
  status: 'running' | 'success' | 'failed';
  summary?: string;
  target?: string;
  durationMs?: number;
}

export interface ExecutionInspectorSummary {
  currentAction: {
    state: 'working' | 'completed' | 'failed' | 'waiting';
    label: 'Working' | 'Completed' | 'Failed' | 'Waiting';
    detail: string;
    target?: string;
  };
  tools: ToolHistoryItem[];
  usage?: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number; totalTokens?: number };
  files: { added: number; removed: number; changed: number };
  durationMs?: number;
}

interface ToolDraft extends ToolHistoryItem {
  startedAt?: string;
}

export function summarizeExecutionInspector(input: {
  status?: ExecutionStatus;
  startedAt?: string;
  completedAt?: string;
  events: InspectorExecutionEvent[];
  runtimeEvents: AgentEvent[];
}): ExecutionInspectorSummary {
  const tools: ToolDraft[] = [];
  const byCallId = new Map<string, ToolDraft>();
  let usage: ExecutionInspectorSummary['usage'];
  const changedPaths = new Set<string>();
  let added = 0;
  let removed = 0;

  for (const event of input.runtimeEvents) {
    const payload = asRecord(event.payload);
    if (event.type === 'execution.tool.started' || event.type === 'execution.tool.completed') {
      const callId = stringValue(payload.callId) || event.eventId;
      const prior = byCallId.get(callId);
      const toolName = stringValue(payload.toolName) || prior?.toolName || 'tool';
      const target = extractTarget(payload) ?? prior?.target;
      const summary = stringValue(payload.summary) || prior?.summary;
      const next: ToolDraft = {
        id: callId,
        toolName,
        status: event.type === 'execution.tool.started' ? 'running' : payload.success === false ? 'failed' : 'success',
        ...(summary ? { summary } : {}),
        ...(target ? { target } : {}),
        ...(numberValue(payload.durationMs) !== undefined ? { durationMs: numberValue(payload.durationMs) } : {}),
        ...(prior?.startedAt ? { startedAt: prior.startedAt } : event.type === 'execution.tool.started' ? { startedAt: event.timestamp } : {}),
      };
      if (prior) {
        const index = tools.indexOf(prior);
        if (index >= 0) tools[index] = next;
      } else {
        tools.push(next);
      }
      byCallId.set(callId, next);
    } else if (event.type === 'execution.usage.recorded') {
      const inputTokens = numberValue(payload.inputTokens);
      const cachedInputTokens = numberValue(payload.cachedInputTokens);
      const outputTokens = numberValue(payload.outputTokens);
      usage = {
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
        ...(inputTokens !== undefined || cachedInputTokens !== undefined || outputTokens !== undefined
          ? { totalTokens: (inputTokens ?? 0) + (cachedInputTokens ?? 0) + (outputTokens ?? 0) }
          : {}),
      };
    } else if (event.type === 'execution.files.changed') {
      const changes = Array.isArray(payload.changes) ? payload.changes : [];
      for (const change of changes) {
        const record = asRecord(change);
        const path = stringValue(record.path);
        if (!path || changedPaths.has(path)) continue;
        changedPaths.add(path);
        const changeType = stringValue(record.changeType);
        if (changeType === 'created') added += 1;
        else if (changeType === 'deleted') removed += 1;
        else changedPaths.add(path);
      }
    }
  }

  const latestStatus = input.status ?? input.events.at(-1)?.status;
  const latestTool = tools.at(-1);
  const currentAction = currentActionFor(latestStatus, latestTool);
  const durationMs = input.startedAt && input.completedAt
    ? Math.max(0, new Date(input.completedAt).getTime() - new Date(input.startedAt).getTime())
    : undefined;

  return {
    currentAction,
    tools: tools.map(({ startedAt: _startedAt, ...tool }) => tool),
    ...(usage ? { usage } : {}),
    files: { added, removed, changed: Math.max(0, changedPaths.size - added - removed) },
    ...(durationMs !== undefined && Number.isFinite(durationMs) ? { durationMs } : {}),
  };
}

function currentActionFor(status: ExecutionStatus | undefined, latestTool: ToolDraft | undefined): ExecutionInspectorSummary['currentAction'] {
  if (status === 'completed') return { state: 'completed', label: 'Completed', detail: '执行完成' };
  if (status === 'failed') return { state: 'failed', label: 'Failed', detail: '执行失败' };
  if (status === 'cancelled') return { state: 'failed', label: 'Failed', detail: '执行已取消' };
  if (status === 'waiting_user') return { state: 'waiting', label: 'Waiting', detail: '等待你的补充信息' };
  if (latestTool?.status === 'running') {
    return {
      state: 'working',
      label: 'Working',
      detail: toolActionLabel(latestTool.toolName),
      ...(latestTool.target ? { target: latestTool.target } : {}),
    };
  }
  const detail = status === 'preparing_context' ? '准备上下文' : status === 'running_cli' ? '调用 CLI' : status === 'streaming_response' ? '生成回复' : '准备执行';
  return { state: 'working', label: 'Working', detail };
}

function toolActionLabel(toolName: string): string {
  if (/read/i.test(toolName)) return '正在读取';
  if (/edit|write|patch|change/i.test(toolName)) return '正在修改';
  if (/command|shell|exec/i.test(toolName)) return '正在执行命令';
  if (/search|grep|find/i.test(toolName)) return '正在搜索';
  return '正在使用工具';
}

function extractTarget(payload: Record<string, unknown>): string | undefined {
  for (const key of ['path', 'filePath', 'file', 'target']) {
    const value = stringValue(payload[key]);
    if (value) return value;
  }
  const source = stringValue(payload.inputPreview) || stringValue(payload.summary);
  const jsonStart = source.indexOf('{');
  if (jsonStart >= 0) {
    try {
      const parsed = asRecord(JSON.parse(source.slice(jsonStart)));
      for (const key of ['path', 'filePath', 'file', 'target']) {
        const value = stringValue(parsed[key]);
        if (value) return value;
      }
    } catch { /* redacted or non-JSON tool previews are handled below */ }
  }
  const match = source.match(/(?:^|\s)(?:[A-Za-z]:[\\/]|\.\.?[\\/]|[\w.-]+[\\/])[^\s,'"}]+/);
  return match?.[0]?.trim();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
