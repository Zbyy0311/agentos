export declare const MAX_DIAGNOSTIC_LINE_CHARS: number;
export declare const MAX_DIAGNOSTIC_EVENT_CHARS: number;
export declare function createDiagnosticRedactor(
  environment?: Readonly<Record<string, string | undefined>>,
): (input: string) => string;
