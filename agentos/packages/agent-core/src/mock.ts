/**
 * MockCLI: fallback when real CLI is not available.
 * Produces deterministic mock outputs for each agent role.
 */
export class MockCLI {
  static run(agentName: string, prompt: string): { stdout: string; stderr: string } {
    const output = MockCLI.generateOutput(agentName, prompt);
    return { stdout: output, stderr: '' };
  }

  private static generateOutput(agentName: string, prompt: string): string {
    const taskSnippet = prompt.slice(0, 100).replace(/\n/g, ' ');
    switch (agentName) {
      case 'Codex':
        return [
          `## Codex Manager Analysis`,
          ``,
          `### Task Understanding`,
          `Received task: ${taskSnippet}`,
          ``,
          `### Subtask Breakdown`,
          `1. Analyze requirements`,
          `2. Design solution architecture`,
          `3. Implement core logic`,
          `4. Review and validate`,
          ``,
          `### Risk Assessment`,
          `- Low: Well-defined task`,
          `- Medium: May need dependency installation`,
          ``,
          `### Next Steps`,
          `Assigning to KimiCode for implementation.`,
          ``,
          `### Decision`,
          `Approved for implementation phase.`,
        ].join('\n');

      case 'KimiCode':
        return [
          `## KimiCode Implementation`,
          ``,
          `### Task`,
          `${taskSnippet}`,
          ``,
          `### Implementation Plan`,
          `1. Create source file structure`,
          `2. Implement core functionality`,
          `3. Add error handling`,
          `4. Write type definitions`,
          ``,
          `### Code Output`,
          `\`\`\`typescript`,
          `// Implementation for: ${taskSnippet}`,
          `export function solve(input: string): string {`,
          `  // TODO: implement logic`,
          `  return \`Processed: \${input}\`;`,
          `}`,
          `\`\`\``,
          ``,
          `### Files Modified`,
          `- src/index.ts (created)`,
          ``,
          `### Notes`,
          `- Ready for review`,
          `- No external dependencies required`,
        ].join('\n');

      case 'OpenCode':
        return [
          `## OpenCode Review`,
          ``,
          `### Review Target`,
          `${taskSnippet}`,
          ``,
          `### Quality Check`,
          `- [x] Code compiles without errors`,
          `- [x] Type safety maintained`,
          `- [x] Error handling present`,
          `- [ ] Unit tests needed`,
          `- [x] No security issues detected`,
          ``,
          `### Risks Found`,
          `- None critical`,
          ``,
          `### Score: 8/10`,
          `Good implementation, add tests before production.`,
        ].join('\n');

      default:
        return `Mock output for ${agentName}:\nTask: ${taskSnippet}\nStatus: Completed (mock)`;
    }
  }
}
