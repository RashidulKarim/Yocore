/**
 * Piscina worker — runs Argon2id hash/verify off the main event loop.
 * See ADR-007. Do not import this file directly; it is loaded by argon2-pool.ts.
 */
import argon2 from 'argon2';

export type WorkerTask =
  | { kind: 'hash'; password: string; options: argon2.Options }
  | { kind: 'verify'; hash: string; password: string };

export type WorkerResult = { kind: 'hash'; hash: string } | { kind: 'verify'; ok: boolean };

export default async function run(task: WorkerTask): Promise<WorkerResult> {
  if (task.kind === 'hash') {
    const hash = await argon2.hash(task.password, { ...task.options, type: argon2.argon2id });
    return { kind: 'hash', hash };
  }
  const ok = await argon2.verify(task.hash, task.password);
  return { kind: 'verify', ok };
}
