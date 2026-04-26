import { ulid } from 'ulid';

/**
 * Generate a prefixed ULID identifier (e.g. "usr_01HXXX...").
 * Convention used across YoCore — see YoCore-System-Design.md §1.
 */
export function newId(prefix: string): string {
  return `${prefix}_${ulid()}`;
}

/**
 * Build a Mongoose `default` thunk that emits prefixed IDs.
 */
export function idDefault(prefix: string): () => string {
  return () => newId(prefix);
}
