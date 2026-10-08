import { describe, expect, it } from 'vitest';
import {
  WINDOWS_NATIVE_BIRTH_IDENTITY_PREFIX,
  canonicalizeNativeBirthIdentityDecimal,
  isValidNativeBirthIdentity,
} from './native-birth-identity.js';

describe('canonical native birth identity (centralized validator)', () => {
  it('accepts the exact canonical durable form', () => {
    expect(isValidNativeBirthIdentity('win32:filetime:134176000000000000')).toBe(true);
    expect(isValidNativeBirthIdentity('win32:filetime:1')).toBe(true);
    expect(isValidNativeBirthIdentity('win32:filetime:18446744073709551615')).toBe(true);
  });

  it('rejects raw untagged decimals, leading zeros, zero, and malformed prefixes', () => {
    for (const bad of [
      '134176000000000000',
      'win32:filetime:0',
      'win32:filetime:013417600000000000',
      'win32:filetime:not-a-number',
      'win32:filetime: 134176000000000000',
      'win32:filetime:134176000000000000 ',
      'win32:filetime:',
      'win32:FileTime:134176000000000000',
      'win32:filetime:134176000000000000x',
      'win32:filetime:18446744073709551616',
      'win32:filetime:99999999999999999999999',
      '',
    ]) {
      expect(isValidNativeBirthIdentity(bad)).toBe(false);
    }
  });

  it('rejects non-string values', () => {
    for (const bad of [null, undefined, 134176000000000000, {}, [], true]) {
      expect(isValidNativeBirthIdentity(bad)).toBe(false);
    }
  });

  it('canonicalizes a valid helper decimal into the tagged durable form', () => {
    expect(canonicalizeNativeBirthIdentityDecimal('134176000000000000')).toBe(
      WINDOWS_NATIVE_BIRTH_IDENTITY_PREFIX + '134176000000000000',
    );
  });

  it('fails closed (null) for non-canonical helper decimals', () => {
    for (const bad of [
      '',
      '0',
      '01',
      '134176000000000000x',
      '134176000000000000 ',
      ' 134176000000000000',
      '+134176000000000000',
      '18446744073709551616',
      '99999999999999999999999',
      null,
      undefined,
      134176000000000000,
    ]) {
      expect(canonicalizeNativeBirthIdentityDecimal(bad)).toBeNull();
    }
  });

  it('round-trips a >2^53 value digit-exactly without Number conversion', () => {
    const decimal = '134176000000000001'; // > 2^53, last digit differs from a rounded Number
    const canonical = canonicalizeNativeBirthIdentityDecimal(decimal);
    expect(canonical).toBe('win32:filetime:' + decimal);
    expect(isValidNativeBirthIdentity(canonical)).toBe(true);
    // The decimal body survives untouched (string equality, no Number path).
    expect(canonical!.slice(WINDOWS_NATIVE_BIRTH_IDENTITY_PREFIX.length)).toBe(decimal);
  });
});

