import { ProviderRegistryError } from './errors.js';
import type { ProviderAdapterManifest, ProviderType, RuntimeProviderAdapter } from './types.js';
import { canonicalProviderType } from './types.js';

export interface ProviderResolveInput {
  readonly providerType?: ProviderType;
  readonly adapterId?: string;
  readonly adapterVersion?: string;
}
export class ProviderRegistry {
  private readonly adapters = new Map<string, RuntimeProviderAdapter>();

  constructor(adapters: readonly RuntimeProviderAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: RuntimeProviderAdapter): void {
    assertManifest(adapter.manifest);
    const key = registryKey(adapter.manifest.id, adapter.manifest.version);
    const existing = this.adapters.get(key);
    if (existing !== undefined) {
      if (existing.manifest.builtIn && !adapter.manifest.builtIn) {
        throw new ProviderRegistryError('BUILTIN_ADAPTER_IMMUTABLE', `built-in adapter ${key} cannot be replaced`);
      }
      throw new ProviderRegistryError('DUPLICATE_ADAPTER', `adapter ${key} is already registered`);
    }
    this.adapters.set(key, adapter);
  }

  unregister(adapterId: string, adapterVersion?: string): void {
    const matches = [...this.adapters.entries()].filter(([key, adapter]) =>
      adapter.manifest.id === adapterId && (adapterVersion === undefined || key === registryKey(adapterId, adapterVersion)));
    for (const [key, adapter] of matches) {
      if (adapter.manifest.builtIn) {
        throw new ProviderRegistryError('BUILTIN_ADAPTER_IMMUTABLE', `built-in adapter ${key} cannot be removed`);
      }
      this.adapters.delete(key);
    }
  }

  get(adapterId: string, adapterVersion: string): RuntimeProviderAdapter {
    const adapter = this.adapters.get(registryKey(adapterId, adapterVersion));
    if (adapter === undefined) {
      throw new ProviderRegistryError(
        'PROVIDER_ADAPTER_NOT_FOUND',
        `adapter ${adapterId}@${adapterVersion} was not found`,
        'PROVIDER_ADAPTER_NOT_FOUND',
      );
    }
    return adapter;
  }

  resolve(input: ProviderResolveInput | ProviderType): RuntimeProviderAdapter {
    if (typeof input === 'string') {
      throw new ProviderRegistryError('PROVIDER_VERSION_UNSUPPORTED', `exact adapter identity is required for ${input}`);
    }
    if (input.adapterId !== undefined && input.adapterVersion === undefined) {
      throw new ProviderRegistryError('PROVIDER_VERSION_UNSUPPORTED', `exact adapter version is required for ${input.adapterId}`);
    }
    if (input.adapterId !== undefined && input.adapterVersion !== undefined) {
      const adapter = this.get(input.adapterId, input.adapterVersion);
      if (input.providerType !== undefined && !adapter.manifest.providerTypes.includes(canonicalProviderType(input.providerType))) {
        throw new ProviderRegistryError('PROVIDER_ADAPTER_NOT_FOUND', `adapter does not support ${input.providerType}`, 'PROVIDER_ADAPTER_NOT_FOUND');
      }
      return adapter;
    }
    if (input.providerType !== undefined) return this.resolve(input.providerType);
    throw new ProviderRegistryError('PROVIDER_ADAPTER_NOT_FOUND', 'adapter identity is required', 'PROVIDER_ADAPTER_NOT_FOUND');
  }

  findByType(providerType: ProviderType): RuntimeProviderAdapter[] {
    const canonical = canonicalProviderType(providerType);
    return [...this.adapters.values()]
      .filter(adapter => adapter.manifest.providerTypes.includes(canonical))
      .sort((a, b) => {
        if (a.manifest.builtIn !== b.manifest.builtIn) return a.manifest.builtIn ? -1 : 1;
        return compareVersions(b.manifest.version, a.manifest.version);
      });
  }

  list(): ProviderAdapterManifest[] {
    return [...this.adapters.values()]
      .map(adapter => adapter.manifest)
      .sort((a, b) => registryKey(a.id, a.version).localeCompare(registryKey(b.id, b.version)));
  }
}

export { ProviderRegistryError } from './errors.js';

function registryKey(id: string, version: string): string {
  return `${id}@${version}`;
}

function assertManifest(manifest: ProviderAdapterManifest): void {
  if (!manifest.id.trim() || !manifest.version.trim() || !manifest.name.trim()) {
    throw new ProviderRegistryError('INVALID_MANIFEST', 'adapter id, name and version are required');
  }
  if (manifest.providerTypes.length === 0 || manifest.runtimeModes.length === 0) {
    throw new ProviderRegistryError('INVALID_MANIFEST', 'adapter manifest must declare provider types and runtime modes');
  }
  if (!Number.isSafeInteger(manifest.configSchemaVersion) || manifest.configSchemaVersion < 1) {
    throw new ProviderRegistryError('INVALID_MANIFEST', 'adapter config schema version must be positive');
  }
}

function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(part => Number.parseInt(part, 10));
  const b = right.split('.').map(part => Number.parseInt(part, 10));
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}
