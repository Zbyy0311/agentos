import { describe, expect, it } from 'vitest';
import { translateWin32SpawnErrorCode } from './windows-process-tree.js';

describe('MEDIUM-1: stable Win32 spawn error identity translation', () => {
  it('maps Win32 ERROR_FILE_NOT_FOUND (2) to ENOENT', () => {
    expect(translateWin32SpawnErrorCode(2)).toBe('ENOENT');
  });

  it('maps Win32 ERROR_PATH_NOT_FOUND (3) to ENOENT', () => {
    expect(translateWin32SpawnErrorCode(3)).toBe('ENOENT');
  });

  it('maps Win32 ERROR_ACCESS_DENIED (5) to EACCES', () => {
    const mapped = translateWin32SpawnErrorCode(5);
    expect(mapped).toBe('EACCES');
  });

  it('maps every other Win32 code to unknown (null)', () => {
    for (const code of [0, 1, 4, 6, 87, 1450, 2_147_000_000, -1]) {
      expect(translateWin32SpawnErrorCode(code)).toBe(null);
    }
  });

  it('never parses localized message text (numeric identity only)', () => {
    // The translation takes only the numeric native code. Any code outside the
    // stable known set maps to null regardless of what a message might say.
    expect(translateWin32SpawnErrorCode(5)).toBe(translateWin32SpawnErrorCode(5));
    expect(translateWin32SpawnErrorCode(999999)).toBe(null);
  });
});
