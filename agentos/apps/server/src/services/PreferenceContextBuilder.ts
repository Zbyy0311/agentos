import type { PreferenceApplication, PreferenceContext, PreferenceContextKind, PreferenceProjection } from '@agentos/shared';
import { classifyPreferenceContext } from './PreferenceContextClassifier.js';
import { resolvePreferenceProjections } from './PreferenceResolver.js';

export const MAX_PREFERENCE_CONTEXT_CHARACTERS = 800;

export function buildPreferenceContext(input: {
  runId: string;
  workspaceId: string;
  objective: string;
  conversationType?: 'direct' | 'group';
  projections: PreferenceProjection[];
}): PreferenceContext {
  const contextKind = classifyPreferenceContext({ objective: input.objective, conversationType: input.conversationType });
  const resolved = resolvePreferenceProjections({ projections: input.projections, workspaceId: input.workspaceId, contextKind });
  if (resolved.length === 0) return { contextKind, text: '', applications: [] };
  const header = `## 用户交互与工作偏好\n以下内容仅为历史默认偏好；如与当前用户要求冲突，以当前要求为准。\n场景：${contextKind}`;
  const sections: string[] = [];
  const applications: PreferenceApplication[] = [];
  for (const [index, preference] of resolved.entries()) {
    const label = preference.status === 'provisional' ? '暂定偏好' : '稳定偏好';
    const section = `- ${preference.dimension}: ${preference.preferredValue}（${label}）`;
    const next = `${header}\n${[...sections, section].join('\n')}`;
    if (next.length > MAX_PREFERENCE_CONTEXT_CHARACTERS) break;
    sections.push(section);
    applications.push({
      runId: input.runId,
      projectionId: preference.projectionId,
      resolvedValue: preference.preferredValue,
      rank: index + 1,
      injectedCharacters: section.length,
      appliedAt: new Date().toISOString(),
    });
  }
  return {
    contextKind,
    text: sections.length ? `${header}\n${sections.join('\n')}` : '',
    applications,
  };
}

export type { PreferenceContextKind };
