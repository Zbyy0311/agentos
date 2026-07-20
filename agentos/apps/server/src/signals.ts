const SIGNAL_EXIT_CODES: Record<string, number> = {
  SIGINT: 130,
  SIGTERM: 143,
  SIGHUP: 129,
};

export function getSignalExitCode(signal: string): number {
  return SIGNAL_EXIT_CODES[signal] ?? 1;
}
