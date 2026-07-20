import type { PreferenceContextKind, PreferenceDimension, PreferenceProjectionStatus } from '@agentos/shared';

export const preferenceContextLabels: Record<PreferenceContextKind, string> = {
  coding: '编码', debugging: '调试', planning: '规划', review: '评审', explanation: '解释', general: '通用',
};

export const preferenceDimensionLabels: Record<PreferenceDimension, string> = {
  response_language: '响应语言', response_detail: '回答详略', execution_style: '执行方式', clarification_style: '澄清方式',
  change_scope: '修改范围', verification_depth: '验收深度', progress_update_style: '进度更新', delivery_format: '交付格式', tooling_habit: '工具习惯',
};

export const preferenceStatusLabels: Record<PreferenceProjectionStatus, string> = {
  observed: '已观察', provisional: '试运行', stable: '稳定', dormant: '已休眠',
};
