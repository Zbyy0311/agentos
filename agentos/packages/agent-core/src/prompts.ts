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
        'Focus on the execution plan and the success criteria for the checking task.',
      ];
    case 'kimi_worker':
      return [
        ...singleTurn,
        'Execute the required checks and report actual results.',
        'Do not claim to have edited files unless the provided context explicitly says so.',
        'If no files were modified, say "None".',
      ];
    case 'opencode_reviewer':
      return [
        ...singleTurn,
        'Review the worker findings and the supporting evidence only.',
        'If evidence is insufficient, return Decision: block.',
      ];
    case 'codex_final_review':
      return [
        ...singleTurn,
        'Make the final decision based on the prior stages and state it explicitly.',
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
      'You are Codex, the Manager Agent.',
      'Your role is to analyze the task, define a concrete execution checklist, assess risks, and decide the approach.',
    ],
    kimi_worker: [
      'You are KimiCode, the Worker Agent.',
      'Your role is to execute the checks from Codex and report actual findings with evidence.',
    ],
    opencode_reviewer: [
      'You are OpenCode, the Reviewer Agent.',
      'Your role is to review the worker findings for correctness, quality, and evidence completeness.',
    ],
    codex_final_review: [
      'You are Codex, the Manager Agent - Final Review.',
      'Your role is to make the final decision on whether the work is accepted.',
    ],
  } satisfies Record<AgentStage, string[]>;

  return [
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
