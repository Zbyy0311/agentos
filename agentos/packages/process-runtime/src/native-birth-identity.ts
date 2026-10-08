/**
 * P6-M3b centralized canonical native birth-identity validation.
 *
 * The single authoritative durable form of a Windows process-creation
 * identity is
 *
 *   win32:filetime:<canonical-unsigned-decimal>
 *
 * where <canonical-unsigned-decimal> is the invariant decimal text of the full
 * 64-bit FILETIME: digits only, no leading zeros (so no zero and no
 * alternative encodings), no whitespace, no locale formatting, and no value
 * beyond the unsigned 64-bit range. The value is platform-tagged and
 * source-tagged TEXT end to end and is NEVER routed through a JS Number,
 * Date.parse, an ISO timestamp, or the wall clock.
 *
 * This module is the ONE shared validator/canonicalizer for the helper
 * boundary (spawn capture and live probe), the recovery classifier, the
 * production verifier, and the server-side repository. Ad-hoc regexes must
 * not be re-implemented at those seams.
 */

export const WINDOWS_NATIVE_BIRTH_IDENTITY_PREFIX = 'win32:filetime:';

/** Exact text of the unsigned 64-bit maximum (18446744073709551615). */
const UINT64_MAX_DECIMAL = '18446744073709551615';
const UINT64_MAX_DIGITS = 20;

/** Canonical decimal body: digits only, first digit 1-9 (no zero, no leading zeros). */
const CANONICAL_DECIMAL_PATTERN = /^[1-9][0-9]{0,19}$/;

/** Full canonical form including the platform/source tag. */
const CANONICAL_IDENTITY_PATTERN = /^win32:filetime:([1-9][0-9]{0,19})$/;

/**
 * Bounds check for an already shape-validated canonical decimal. Pure string
 * comparison (equal-length digit strings order lexicographically) so the
 * production path never needs a numeric conversion of any width.
 */
function decimalWithinUint64(decimal: string): boolean {
  if (decimal.length > UINT64_MAX_DIGITS) return false;
  if (decimal.length === UINT64_MAX_DIGITS) return decimal <= UINT64_MAX_DECIMAL;
  return true;
}

/**
 * Whether `value` is an EXACT canonical native birth identity:
 * 'win32:filetime:<positive canonical decimal within uint64>'. Rejects raw
 * untagged decimals, leading-zero variants, zero, empty strings, malformed
 * prefixes, non-digits, whitespace, values beyond uint64, and every non-string.
 */
export function isValidNativeBirthIdentity(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = CANONICAL_IDENTITY_PATTERN.exec(value);
  if (match === null) return false;
  return decimalWithinUint64(match[1]);
}

/**
 * Canonicalize the invariant unsigned-decimal FILETIME text emitted by the
 * fixed Windows helper into the durable tagged form. Returns null for any
 * non-canonical decimal (fail-closed: capture becomes unavailable, never a
 * guessed or partially normalized identity). The decimal never passes through
 * a JS Number on this path.
 */
export function canonicalizeNativeBirthIdentityDecimal(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (!CANONICAL_DECIMAL_PATTERN.test(raw)) return null;
  if (!decimalWithinUint64(raw)) return null;
  return WINDOWS_NATIVE_BIRTH_IDENTITY_PREFIX + raw;
}
