import type { TransactionDatabase } from '../store/Transaction.js';
import { MemoryEntryRepository } from '../store/MemoryEntryRepository.js';
import { MemoryRetrievalService } from './MemoryRetrievalService.js';
import { HttpMemoryEmbeddingPort, MemorySemanticRetrieval, type MemoryEmbeddingPort, type MemorySemanticReason } from './MemorySemanticRetrieval.js';
import { requireMemorySemanticQualityReceipt } from './MemorySemanticQualityGate.js';

export interface MemoryRetrievalRuntimeConfig {
  /** `off` is the default and leaves MF-3 ranking byte-for-byte unchanged. */
  readonly mode?: 'off' | 'local' | 'remote';
  readonly localPort?: MemoryEmbeddingPort;
  readonly localEndpoint?: string;
  readonly localModelId?: string;
  readonly localModelVersion?: string;
  readonly localApiKey?: string;
  readonly remoteEndpoint?: string;
  readonly remoteModelId?: string;
  readonly remoteModelVersion?: string;
  readonly remoteApiKey?: string;
  /** Remote text transfer needs a distinct, explicit opt-in. */
  readonly remoteEnabled?: boolean;
  readonly fetch?: typeof fetch;
}

export interface MemoryRetrievalRuntime {
  readonly retrieval: MemoryRetrievalService;
  readonly semantic?: MemorySemanticRetrieval;
  readonly mode: 'off' | 'local' | 'remote' | 'remote-disabled' | 'unavailable';
  readonly degradedReason?: MemorySemanticReason;
}

function nonBlank(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

/**
 * Build the optional process-local semantic sidecar. No synthetic/default
 * adapter is selected. Local adapters are injected explicitly; remote config
 * requires both mode=remote and remoteEnabled=true.
 */
export function createMemoryRetrievalRuntime(
  db: TransactionDatabase,
  config: MemoryRetrievalRuntimeConfig = {},
): MemoryRetrievalRuntime {
  const entries = new MemoryEntryRepository(db);
  const mode = config.mode ?? 'off';
  if (mode === 'off') return { retrieval: new MemoryRetrievalService(entries), mode: 'off' };

  const unavailable = (reason: MemorySemanticReason, resultMode: MemoryRetrievalRuntime['mode'] = 'unavailable'): MemoryRetrievalRuntime => {
    const semantic = new MemorySemanticRetrieval(db, undefined, { unavailableReason: reason });
    return { retrieval: new MemoryRetrievalService(entries, undefined, semantic), semantic, mode: resultMode, degradedReason: reason };
  };

  if (mode === 'local') {
    let port = config.localPort;
    if (port === undefined && nonBlank(config.localEndpoint)
      && nonBlank(config.localModelId) && nonBlank(config.localModelVersion)) {
      try {
        port = new HttpMemoryEmbeddingPort({
          endpoint: config.localEndpoint,
          modelId: config.localModelId,
          modelVersion: config.localModelVersion,
          ...(config.localApiKey === undefined ? {} : { apiKey: config.localApiKey }),
          ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
        });
      } catch {
        return unavailable('REMOTE_CONFIG_INVALID');
      }
    }
    if (port === undefined) return unavailable('SEMANTIC_ADAPTER_UNAVAILABLE');
    if (port.isRemote) return unavailable('REMOTE_CONFIG_INVALID');
    const semantic = new MemorySemanticRetrieval(db, port, {
      qualityGate: () => requireMemorySemanticQualityReceipt(db, port!.modelId, port!.modelVersion),
    });
    return { retrieval: new MemoryRetrievalService(entries, undefined, semantic), semantic, mode: 'local' };
  }

  if (mode !== 'remote') return unavailable('SEMANTIC_ADAPTER_UNAVAILABLE');
  if (config.remoteEnabled !== true) return unavailable('REMOTE_DISABLED', 'remote-disabled');
  if (!nonBlank(config.remoteEndpoint) || !nonBlank(config.remoteModelId) || !nonBlank(config.remoteModelVersion)) {
    return unavailable('REMOTE_CONFIG_INVALID');
  }
  try {
    const port = new HttpMemoryEmbeddingPort({
      endpoint: config.remoteEndpoint,
      modelId: config.remoteModelId,
      modelVersion: config.remoteModelVersion,
      ...(config.remoteApiKey === undefined ? {} : { apiKey: config.remoteApiKey }),
      ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
    });
    const semantic = new MemorySemanticRetrieval(db, port, { remoteEnabled: true,
      qualityGate: () => requireMemorySemanticQualityReceipt(db, port.modelId, port.modelVersion),
    });
    return {
      retrieval: new MemoryRetrievalService(entries, undefined, semantic),
      semantic,
      mode: port.isRemote ? 'remote' : 'local',
    };
  } catch {
    return unavailable('REMOTE_CONFIG_INVALID');
  }
}

/** Explicit environment parser; absent `AGENTOS_MEMORY_SEMANTIC_MODE` means off. */
export function memoryRetrievalRuntimeConfigFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): MemoryRetrievalRuntimeConfig {
  const mode = environment.AGENTOS_MEMORY_SEMANTIC_MODE;
  if (mode !== 'local' && mode !== 'remote') return { mode: 'off' };
  if (mode === 'local') return {
    mode: 'local',
    ...(environment.AGENTOS_MEMORY_SEMANTIC_ENDPOINT === undefined ? {} : { localEndpoint: environment.AGENTOS_MEMORY_SEMANTIC_ENDPOINT }),
    ...(environment.AGENTOS_MEMORY_SEMANTIC_MODEL_ID === undefined ? {} : { localModelId: environment.AGENTOS_MEMORY_SEMANTIC_MODEL_ID }),
    ...(environment.AGENTOS_MEMORY_SEMANTIC_MODEL_VERSION === undefined ? {} : { localModelVersion: environment.AGENTOS_MEMORY_SEMANTIC_MODEL_VERSION }),
    ...(environment.AGENTOS_MEMORY_SEMANTIC_API_KEY === undefined ? {} : { localApiKey: environment.AGENTOS_MEMORY_SEMANTIC_API_KEY }),
  };
  return {
    mode: 'remote',
    remoteEnabled: environment.AGENTOS_MEMORY_SEMANTIC_REMOTE_ENABLED === 'true',
    ...(environment.AGENTOS_MEMORY_SEMANTIC_ENDPOINT === undefined ? {} : { remoteEndpoint: environment.AGENTOS_MEMORY_SEMANTIC_ENDPOINT }),
    ...(environment.AGENTOS_MEMORY_SEMANTIC_MODEL_ID === undefined ? {} : { remoteModelId: environment.AGENTOS_MEMORY_SEMANTIC_MODEL_ID }),
    ...(environment.AGENTOS_MEMORY_SEMANTIC_MODEL_VERSION === undefined ? {} : { remoteModelVersion: environment.AGENTOS_MEMORY_SEMANTIC_MODEL_VERSION }),
    ...(environment.AGENTOS_MEMORY_SEMANTIC_API_KEY === undefined ? {} : { remoteApiKey: environment.AGENTOS_MEMORY_SEMANTIC_API_KEY }),
  };
}
