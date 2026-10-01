import assert from 'node:assert/strict';
import test from 'node:test';
import type { TransactionDatabase } from '../store/Transaction.js';
import {
  createMemoryRetrievalRuntime,
  memoryRetrievalRuntimeConfigFromEnvironment,
} from './MemoryRetrievalRuntime.js';

const db = {} as TransactionDatabase;

const localPort = {
  modelId: 'injected-local-test-port',
  modelVersion: 'fixture-v1',
  isRemote: false,
  async embed(texts: readonly string[]) { return texts.map(() => [1, 0]); },
};

test('semantic runtime defaults off even when endpoint variables are present', () => {
  const config = memoryRetrievalRuntimeConfigFromEnvironment({
    AGENTOS_MEMORY_SEMANTIC_ENDPOINT: 'https://embedding.example/v1/embeddings',
    AGENTOS_MEMORY_SEMANTIC_MODEL_ID: 'model',
    AGENTOS_MEMORY_SEMANTIC_MODEL_VERSION: 'v1',
  });
  const runtime = createMemoryRetrievalRuntime(db, config);
  assert.equal(config.mode, 'off');
  assert.equal(runtime.mode, 'off');
  assert.equal(runtime.semantic, undefined);
});

test('local mode requires an explicit loopback adapter or injected local port', () => {
  const missing = createMemoryRetrievalRuntime(db, { mode: 'local' });
  assert.equal(missing.mode, 'unavailable');
  assert.equal(missing.degradedReason, 'SEMANTIC_ADAPTER_UNAVAILABLE');

  const injected = createMemoryRetrievalRuntime(db, { mode: 'local', localPort });
  assert.equal(injected.mode, 'local');
  assert.ok(injected.semantic);

  const loopback = createMemoryRetrievalRuntime(db, {
    mode: 'local',
    localEndpoint: 'http://127.0.0.1:11434/v1/embeddings',
    localModelId: 'local-embedding-model',
    localModelVersion: 'v1',
  });
  assert.equal(loopback.mode, 'local');
  assert.ok(loopback.semantic);
});

test('production factory refuses semantic preparation before a real model quality receipt exists', async () => {
  const runtime = createMemoryRetrievalRuntime(db, { mode: 'local', localPort });
  const status = await runtime.semantic!.prepare('valid query', []);
  assert.equal(status.degraded, true);
  assert.equal(status.reason, 'SEMANTIC_QUALITY_GATE_REQUIRED');
  assert.equal(runtime.semantic!.rerank([], 'valid query').reason, 'SEMANTIC_QUALITY_GATE_REQUIRED');
});

test('remote mode requires its independent explicit opt-in and invalid config degrades visibly', async () => {
  const disabled = createMemoryRetrievalRuntime(db, {
    mode: 'remote',
    remoteEndpoint: 'https://embedding.example/v1/embeddings',
    remoteModelId: 'remote-model',
    remoteModelVersion: 'v1',
  });
  assert.equal(disabled.mode, 'remote-disabled');
  assert.equal((await disabled.semantic!.prepare('query', [])).reason, 'REMOTE_DISABLED');

  const enabled = createMemoryRetrievalRuntime(db, {
    mode: 'remote',
    remoteEnabled: true,
    remoteEndpoint: 'https://embedding.example/v1/embeddings',
    remoteModelId: 'remote-model',
    remoteModelVersion: 'v1',
  });
  assert.equal(enabled.mode, 'remote');
  assert.ok(enabled.semantic);

  const invalid = createMemoryRetrievalRuntime(db, {
    mode: 'remote',
    remoteEnabled: true,
    remoteEndpoint: 'http://embedding.example/v1/embeddings',
    remoteModelId: 'remote-model',
    remoteModelVersion: 'v1',
  });
  assert.equal(invalid.mode, 'unavailable');
  assert.equal(invalid.degradedReason, 'REMOTE_CONFIG_INVALID');
  assert.equal((await invalid.semantic!.prepare('query', [])).reason, 'REMOTE_CONFIG_INVALID');
});
