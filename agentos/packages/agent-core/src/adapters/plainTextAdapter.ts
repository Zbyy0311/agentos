import type { AgentCliAdapter, CliEventParser, NormalizedCliEvent } from './types.js';

class PlainTextParser implements CliEventParser {
  push(chunk: string): NormalizedCliEvent[] {
    return chunk ? [{ type: 'assistant.message', text: chunk }] : [];
  }

  finish(): NormalizedCliEvent[] {
    return [];
  }
}

export class PlainTextAdapter implements AgentCliAdapter {
  readonly provider = 'plain' as const;

  matches(_command: string): boolean {
    return true;
  }

  supportsStructuredOutput(_helpText: string): boolean {
    return false;
  }

  decorateArgs(args: readonly string[]): string[] {
    return [...args];
  }

  createParser(): CliEventParser {
    return new PlainTextParser();
  }
}
