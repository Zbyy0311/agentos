export type ToolRiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface ToolRiskInput { toolName: string; commandSummary?: string; affectedPaths?: string[]; }

export function classifyToolRisk(input: ToolRiskInput): ToolRiskLevel {
  const text = `${input.toolName} ${input.commandSummary ?? ''} ${(input.affectedPaths ?? []).join(' ')}`.toLowerCase();
  if (/rm\s+-rf|format\s+|drop\s+database|credential|secret|private.?key/.test(text)) return 'critical';
  if (/write|edit|delete|move|shell|exec|install|network|publish/.test(text)) return 'high';
  if (/git|test|build|read|list|search|grep|glob/.test(text)) return 'low';
  return 'medium';
}
