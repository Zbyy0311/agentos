import { useState, useEffect, useCallback } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

interface ApiOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  timeout?: number;
}

export function useApi() {
  const request = useCallback(async <T = unknown>(path: string, options: ApiOptions = {}): Promise<T> => {
    const controller = new AbortController();
    const timeoutMs = options.timeout ?? 10000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(`${API_BASE}${path}`, {
        method: options.method || 'GET',
        headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
        body: options.body ? JSON.stringify(options.body) : undefined,
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      return res.json() as Promise<T>;
    } finally {
      clearTimeout(timer);
    }
  }, []);

  return { API_BASE, request };
}

export type { ApiOptions };
