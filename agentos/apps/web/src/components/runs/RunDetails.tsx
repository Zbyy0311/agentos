'use client';

import type { AgentRunDetails } from '@agentos/shared';
import { getRunDurationMs, getRunFailureReason, normalizeRunDetails } from '@/lib/runDetails';

interface RunDetailsProps {
  details: AgentRunDetails;
  onClose(): void;
  onGenerateCandidates?(runId: string): void;
  generatingCandidates?: boolean;
}

const statusLabels = { queued: '排队中', running: '执行中', waiting_user: '等待用户补充', completed: '已完成', failed: '失败', cancelled: '已取消' } as const;

export function RunDetails({ details: sourceDetails, onClose, onGenerateCandidates, generatingCandidates = false }: RunDetailsProps) {
  const details = normalizeRunDetails(sourceDetails);
  const duration = getRunDurationMs(details);
  const failureReason = getRunFailureReason(details);
  return <div className="fixed inset-0 z-[80] grid place-items-center bg-black/50 p-6" role="dialog" aria-modal="true" aria-label="本次执行详情">
    <section className="ui-panel max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl border p-6 shadow-[var(--app-shadow)]">
      <div className="mb-6 flex items-start justify-between gap-4"><div><div className="text-[11px] tracking-[0.16em] ui-dim">RUN DETAILS</div><h2 className="mt-1 text-lg font-semibold ui-text">本次执行详情</h2></div><div className="flex items-center gap-2"><button type="button" onClick={() => onGenerateCandidates?.(details.run.id)} disabled={details.run.status !== 'completed' || generatingCandidates} className="ui-button-ghost rounded-lg px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50">{generatingCandidates ? '生成中…' : '生成记忆候选'}</button><button type="button" onClick={onClose} className="ui-button-ghost rounded-lg px-2 py-1 text-sm">关闭</button></div></div>
      <div className="space-y-6 text-sm">
        <section><h3 className="mb-2 font-medium ui-text">原始需求</h3><p className="whitespace-pre-wrap rounded-xl bg-[var(--app-surface-soft)] p-3 leading-6 ui-text-soft">{details.sourceMessage.content || '（仅包含附件）'}</p></section>
        <section><h3 className="mb-2 font-medium ui-text">状态与耗时</h3><p className="ui-text-soft">{statusLabels[details.run.status]}{duration === undefined ? '' : ` · ${Math.round(duration / 1000)} 秒`}</p>{details.run.waitingQuestion && <p className="mt-2 rounded-lg border border-[var(--app-accent)]/40 p-3 ui-text-soft">等待问题：{details.run.waitingQuestion}</p>}{failureReason && <p className="mt-2 text-[var(--app-danger)]">失败原因：{failureReason}</p>}</section>
        <section><h3 className="mb-2 font-medium ui-text">参与 Agent</h3>{details.executions.length ? <ul className="space-y-1 text-xs ui-text-soft">{Array.from(new Set(details.executions.map(execution => execution.agentId))).map(agentId => <li key={agentId}>{agentId}</li>)}</ul> : <p className="ui-dim">暂无参与 Agent</p>}</section>
        <section><h3 className="mb-2 font-medium ui-text">公开事件时间线</h3>{details.events.length ? <ol className="space-y-2">{details.events.map(event => <li key={event.eventId} className="rounded-lg border ui-border px-3 py-2"><div className="ui-text-soft">{event.type}</div><div className="mt-1 text-xs ui-dim">{new Date(event.timestamp).toLocaleString('zh-CN')}</div></li>)}</ol> : <p className="ui-dim">暂无公开事件</p>}</section>
        <section><h3 className="mb-2 font-medium ui-text">CLI 调用</h3>{details.cliInvocations.length ? <ul className="space-y-2">{details.cliInvocations.map(invocation => <li key={invocation.id} className="rounded-lg border ui-border px-3 py-2 text-xs ui-text-soft">{invocation.commandLabel} · {invocation.exitCode === 0 ? '成功' : `退出码 ${invocation.exitCode ?? '未知'}`} · {invocation.durationMs}ms</li>)}</ul> : <p className="ui-dim">暂无可观测 CLI 调用</p>}</section>
        <section><h3 className="mb-2 font-medium ui-text">修改文件</h3>{details.fileChanges.length ? <ul className="space-y-1 text-xs ui-text-soft">{details.fileChanges.map(change => <li key={`${change.path}:${change.changeType}`}>{change.changeType} · {change.path}</li>)}</ul> : <p className="ui-dim">无 Git 文件变化或当前工作区不可采集</p>}</section>
        <section><h3 className="mb-2 font-medium ui-text">最终总结</h3><p className="whitespace-pre-wrap leading-6 ui-text-soft">{details.run.resultSummary || failureReason || '暂无最终总结'}</p></section>
        <section><h3 className="mb-2 font-medium ui-text">使用的项目记忆</h3>{details.usedMemories.length ? <ul className="space-y-1 text-xs ui-text-soft">{details.usedMemories.map(memory => <li key={memory.memoryId}>{memory.memoryId} · {memory.injectedCharacters} 字符</li>)}</ul> : <p className="ui-dim">本次未使用项目记忆</p>}</section>
      </div>
    </section>
  </div>;
}
