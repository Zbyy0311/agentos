export function resolveAttachmentUrl(apiBase: string, url: string): string {
  if (/^(?:https?:|blob:|data:)/i.test(url)) return url;
  return `${apiBase.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`;
}
