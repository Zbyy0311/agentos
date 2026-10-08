import type { AgentStage, TaskLog } from '@agentos/shared';

export function buildStageInstructions(stage: AgentStage): string[] {
  const singleTurn = [
    'This is a single-turn CLI invocation.',
    'Do not ask follow-up questions.',
    'Do not wait for confirmation.',
    'Return plain text only.',
  ];

  switch (stage) {
    case 'codex_manager':
      return [
        ...singleTurn,
        'Focus on understanding the request, selecting a useful collaboration path, and defining success criteria appropriate to its actual domain.',
      ];
    case 'kimi_worker':
      return [
        ...singleTurn,
        'Execute the required checks and report actual results.',
        'Contribute analysis, actions, or deliverables appropriate to the request; do not assume the task is about code.',
        'Do not claim to have edited files or completed external actions unless the provided context explicitly says so.',
        'If no files were modified, say "None".',
      ];
    case 'opencode_reviewer':
      return [
        ...singleTurn,
        'Review the prior findings and supporting evidence for correctness, relevance, quality, and completeness.',
        'If evidence is insufficient, return Decision: block.',
      ];
    case 'codex_final_review':
      return [
        ...singleTurn,
        'Make the final decision based on the original request and prior-stage evidence, and state it explicitly.',
      ];
  }
}

export function buildStageOutputRequirements(stage: AgentStage): string[] {
  switch (stage) {
    case 'codex_manager':
      return [
        '1. Task Understanding',
        '2. Execution Checklist',
        '3. Risk Assessment',
        '4. Success Criteria',
        '5. Decision',
      ];
    case 'kimi_worker':
      return [
        '1. Checks Run',
        '2. Findings by Severity',
        '3. Evidence',
        '4. Files Modified',
        '5. Notes for Reviewer',
      ];
    case 'opencode_reviewer':
      return [
        '1. Review of Findings',
        '2. Missing Evidence',
        '3. Confidence',
        '4. Decision',
      ];
    case 'codex_final_review':
      return [
        '1. Summary',
        '2. Final Decision',
        '3. Blocking Issues',
        '4. Next Steps',
      ];
  }
}

export function buildStagePrompt(stage: AgentStage, context: string): string {
  const roleIntro = {
    codex_manager: [
      'You are Codex, the Manager Agent in a general-purpose collaboration system.',
      'Your role is to understand the actual user request, choose whether to answer, discuss, plan, analyze, or execute, define useful success criteria, assess risks, and decide the approach.',
    ],
    kimi_worker: [
      'You are KimiCode, the Worker Agent in a general-purpose collaboration system.',
      'Your role is to contribute the analysis, execution, research, or deliverable requested by the Manager, and report actual findings with evidence.',
    ],
    opencode_reviewer: [
      'You are OpenCode, the Reviewer Agent in a general-purpose collaboration system.',
      'Your role is to review prior contributions for correctness, relevance, quality, risks, and evidence completeness; the subject need not be code.',
    ],
    codex_final_review: [
      'You are Codex, the Manager Agent - Final Review.',
      'Your role is to decide whether the response or deliverable satisfies the original request, including any remaining limitations.',
    ],
  } satisfies Record<AgentStage, string[]>;

  return [
    'You are a general-purpose AgentOS collaborator.',
    'Handle questions, explanations, discussions, planning, research, creative work, analysis, and code or tool execution as appropriate to the request.',
    'Do not treat every request as a coding, repository, or file-modification task. The current stage defines your collaboration responsibility, not the task domain.',
    'Use tools or modify files only when the request, permissions, and stage require it; report only work that actually happened.',
    '',
    ...roleIntro[stage],
    '',
    context,
    '',
    '## Output Requirements',
    ...buildStageOutputRequirements(stage),
  ].join('\n');
}

export function buildPreviousOutput(stage: AgentStage, previousLogs: TaskLog[], trimSection: (content: string, maxChars: number) => string): string {
  if (previousLogs.length === 0) return '';

  const logsToUse = stage === 'codex_final_review'
    ? previousLogs
    : previousLogs.slice(-1);

  return logsToUse
    .map((log) => {
      const stdout = trimSection(log.stdout, 2500);
      return `[${log.stage}] ${log.agentName}:\n${stdout}`;
    })
    .join('\n\n');
}
