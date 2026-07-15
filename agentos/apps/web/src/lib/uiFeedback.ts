export type ToastTone = 'success' | 'warning' | 'error';
export type UiErrorKind = 'connection' | 'execution' | 'validation';

export interface ToastItem {
  id: string;
  tone: ToastTone;
  message: string;
  durationMs: number;
}

export interface SendButtonState {
  disabled: boolean;
  showSpinner: boolean;
  ariaBusy: boolean;
  label: string;
}

export const TOAST_DURATION_MS = 3200;

export function classifyUiError(error: unknown): UiErrorKind {
  const name = error instanceof Error ? error.name : '';
  return name === 'UnexpectedStreamEndError' || name === 'StreamHttpError' ? 'connection' : 'execution';
}

export function getComposerValidationError(content: string, attachmentCount: number): string {
  return content.trim() || attachmentCount > 0 ? '' : '请输入消息或添加图片';
}

export function getSendButtonState(input: { canSend: boolean; sending: boolean }): SendButtonState {
  return {
    disabled: !input.canSend,
    showSpinner: input.sending,
    ariaBusy: input.sending,
    label: input.sending ? '加入队列' : '发送消息',
  };
}
