#!/usr/bin/env tsx
/**
 * V1.0-J — Log redaction audit.
 *
 * Builds an object that hits every Pino redaction path, then asserts that no
 * canary-secret value survives in the JSON-serialized log line.
 *
 * Run from `apps/api/`:
 *   node --import tsx scripts/audit-log-redaction.ts
 */
import { Writable } from 'node:stream';
import pino from 'pino';
import { __redactPathsForTesting } from '../src/lib/logger.js';

const SECRET = 'CANARY_SECRET_VALUE_DO_NOT_LEAK_42';

function parsePath(path: string): string[] {
  const segments: string[] = [];
  let i = 0;
  while (i < path.length) {
    if (path[i] === '.') {
      i += 1;
      continue;
    }
    if (path[i] === '[') {
      const end = path.indexOf(']', i);
      const inner = path.slice(i + 1, end);
      segments.push(inner.replace(/^['"]|['"]$/g, ''));
      i = end + 1;
    } else {
      let end = i;
      while (end < path.length && path[end] !== '.' && path[end] !== '[') end += 1;
      segments.push(path.slice(i, end));
      i = end;
    }
  }
  return segments;
}

function buildPayload(): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    body: {},
    user: {},
    data: {},
    req: { headers: {} },
    res: { headers: {} },
    headers: {},
  };

  for (const path of __redactPathsForTesting) {
    const segments = parsePath(path);
    if (segments.length === 0) continue;

    if (segments[0] === '*') {
      for (const host of ['body', 'user', 'data']) {
        let cursor = payload[host] as Record<string, unknown>;
        for (let i = 1; i < segments.length - 1; i += 1) {
          const seg = segments[i] as string;
          if (typeof cursor[seg] !== 'object' || cursor[seg] === null) cursor[seg] = {};
          cursor = cursor[seg] as Record<string, unknown>;
        }
        cursor[segments[segments.length - 1] as string] = SECRET;
      }
      continue;
    }

    let cursor: Record<string, unknown> = payload;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const seg = segments[i] as string;
      if (typeof cursor[seg] !== 'object' || cursor[seg] === null) cursor[seg] = {};
      cursor = cursor[seg] as Record<string, unknown>;
    }
    cursor[segments[segments.length - 1] as string] = SECRET;
  }
  return payload;
}

const chunks: string[] = [];
const sink = new Writable({
  write(chunk, _enc, cb) {
    chunks.push(chunk.toString());
    cb();
  },
});

const log = pino(
  {
    level: 'info',
    redact: { paths: __redactPathsForTesting, censor: '[REDACTED]' },
  },
  sink,
);

log.info(buildPayload(), 'audit-log-redaction probe');
const out = chunks.join('');

if (out.includes(SECRET)) {
  console.error('❌ Log redaction audit FAILED — canary survived in serialized log:');
  console.error(out);
  process.exit(1);
}

console.log(
  `✅ Log redaction audit passed — ${__redactPathsForTesting.length} paths protected, no canary leaked.`,
);
