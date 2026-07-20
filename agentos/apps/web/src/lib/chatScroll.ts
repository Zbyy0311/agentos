export function isNearBottom(input: { scrollTop: number; clientHeight: number; scrollHeight: number }, threshold = 96): boolean {
  return input.scrollHeight - (input.scrollTop + input.clientHeight) <= threshold;
}

export function shouldKeepChatAnchor(input: { userInitiated: boolean; wasNearBottom: boolean }): boolean {
  return !input.userInitiated && input.wasNearBottom;
}

