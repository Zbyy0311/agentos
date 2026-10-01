import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteStore } from '../apps/server/src/store/SqliteStore.js';
import { HttpMemoryEmbeddingPort, MemoryEmbeddingError } from '../apps/server/src/services/MemorySemanticRetrieval.js';
import {
  evaluateAndRecordMemorySemanticQualityReceipt,
  MemorySemanticQualityGateError,
} from '../apps/server/src/services/MemorySemanticQualityGate.js';

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new MemorySemanticQualityGateError(`REQUIRED_ENV_MISSING:${name}`);
  }
  return value.trim();
}

function safeFailureCode(error: unknown): string {
  if (error instanceof MemoryEmbeddingError) return error.reason;
  if (error instanceof MemorySemanticQualityGateError) {
    return error.semanticReason ?? error.code;
  }
  return 'EVALUATION_FAILED';
}

async function main(): Promise<void> {
  const projectRoot = resolve(requiredEnvironment('AGENTOS_PROJECT_ROOT'));
  if (!statSync(projectRoot).isDirectory()) {
    throw new MemorySemanticQualityGateError('PROJECT_ROOT_INVALID');
  }

  const endpoint = requiredEnvironment('AGENTOS_MEMORY_SEMANTIC_ENDPOINT');
  const modelId = requiredEnvironment('AGENTOS_MEMORY_SEMANTIC_MODEL_ID');
  const modelVersion = requiredEnvironment('AGENTOS_MEMORY_SEMANTIC_MODEL_VERSION');
  const remoteEnabled = process.env.AGENTOS_MEMORY_SEMANTIC_REMOTE_ENABLED === 'true';
  const apiKey = process.env.AGENTOS_MEMORY_SEMANTIC_API_KEY;

  const embedding = new HttpMemoryEmbeddingPort({
    endpoint,
    modelId,
    modelVersion,
    ...(apiKey === undefined ? {} : { apiKey }),
  });
  if (embedding.isRemote && !remoteEnabled) {
    throw new MemorySemanticQualityGateError('REMOTE_OPT_IN_REQUIRED');
  }

  const sourceRoot = fileURLToPath(new URL('..', import.meta.url));
  const evaluatedHead = execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  if (evaluatedHead === '') throw new MemorySemanticQualityGateError('SOURCE_REVISION_UNAVAILABLE');

  const store = new SqliteStore(projectRoot);
  try {
    const report = await evaluateAndRecordMemorySemanticQualityReceipt(
      store.getDatabase(),
      embedding,
      { evaluatedHead, remoteEnabled },
    );
    console.log(JSON.stringify({
      passed: report.passed,
      receiptWritten: report.receiptWritten,
      modelId: report.modelId,
      modelVersion: report.modelVersion,
      corpusHash: report.corpusHash,
      evaluatedHead,
      queryCount: report.queryCount,
      relevantQueryCount: report.relevantQueryCount,
      paraphraseQueryCount: report.paraphraseQueryCount,
      noMatchQueryCount: report.noMatchQueryCount,
      baselineRecallAt5: report.baselineRecallAt5,
      hybridRecallAt5: report.hybridRecallAt5,
      baselineParaphraseRecallAt5: report.baselineParaphraseRecallAt5,
      hybridParaphraseRecallAt5: report.hybridParaphraseRecallAt5,
      baselineNoMatchFalsePositives: report.baselineNoMatchFalsePositives,
      hybridNoMatchFalsePositives: report.hybridNoMatchFalsePositives,
    }, null, 2));
    if (!report.passed) process.exitCode = 1;
  } finally {
    store.close();
  }
}

main().catch(error => {
  console.error(`Memory semantic evaluation failed: ${safeFailureCode(error)}`);
  process.exitCode = 1;
});
