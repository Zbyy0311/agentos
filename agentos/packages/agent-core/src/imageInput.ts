import { isCodexCli, isOpenCodeCli } from './config.js';
import type { AgentRole, AgentStage } from '@agentos/shared';

export interface AgentImageAttachment {
  name: string;
  mimeType: string;
  absolutePath: string;
}

export type ImageInputTransport = 'none' | 'cli-flag' | 'workspace-path' | 'unsupported';

export interface ImageInputPlan {
  transport: ImageInputTransport;
  cliArgs: string[];
  promptSuffix?: string;
  error?: string;
}

export function resolveImageInput(agent: { role: AgentRole | AgentStage; cliCommand: string }, attachments: AgentImageAttachment[]): ImageInputPlan {
  if (attachments.length === 0) return { transport: 'none', cliArgs: [] };
  if (isCodexCli(agent.cliCommand)) {
    return {
      transport: 'cli-flag',
      cliArgs: attachments.flatMap(attachment => ['--image', attachment.absolutePath]),
    };
  }
  if (agent.role === 'kimi' || agent.role === 'kimi_worker' || agent.role === 'opencode' || agent.role === 'opencode_reviewer' || agent.role === 'mimo' || isOpenCodeCli(agent.cliCommand)) {
    return {
      transport: 'workspace-path',
      cliArgs: [],
      promptSuffix: buildWorkspacePathPrompt(attachments),
    };
  }
  return {
    transport: 'unsupported',
    cliArgs: [],
    error: `${agent.role} 当前 CLI 不支持图片输入，无法安全发送附件`,
  };
}

function buildWorkspacePathPrompt(attachments: AgentImageAttachment[]): string {
  const lines = attachments.map(attachment => `- ${attachment.name}: ${attachment.absolutePath}`);
  return [
    '## 用户图片附件',
    '以下是用户提供的图片文件。请使用当前 Agent 支持的文件/图片工具读取后再回答，不要只根据文件名猜测内容。',
    ...lines,
  ].join('\n');
}
