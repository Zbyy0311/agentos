import { useState, useEffect, useCallback } from 'react';
import { AgentOSError, createAgentOSClient } from '@agentos/api-client';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

interface ApiOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  timeout?: number;
  headers?: Record<string, string>;
}

export function useApi() {
  const request = useCallback(async <T = unknown>(path: string, options: ApiOptions = {}): Promise<T> => {
    try {
      return await createAgentOSClient({ baseUrl: API_BASE }).request<T>(path, {
        ...(options.method === undefined ? {} : { method: options.method }),
        ...(options.body === undefined ? {} : { body: options.body }),
        ...(options.headers === undefined ? {} : { headers: options.headers }),
        ...(options.timeout === undefined ? {} : { timeoutMs: options.timeout }),
      });
    } catch (error) {
      // Preserve the legacy `{ code?: string }` shape that callers rely on:
      // the server-provided machine code shadows the mapped status code.
      if (error instanceof AgentOSError) {
        if (error.serverCode !== undefined) (error as unknown as { code?: string }).code = error.serverCode;
        throw error;
      }
      throw error;
    }
  }, []);

  return { API_BASE, request };
}

export type { ApiOptions };
