#!/usr/bin/env node
/**
 * Mongo index audit script.
 *
 * Connects to the configured Mongo instance, then for every Mongoose model
 * registered in `src/db/index.ts`:
 *   1. Calls `model.syncIndexes({ background: true })` (idempotent).
 *   2. Lists the resulting `getIndexes()` from the live collection.
 *   3. Prints a concise table.
 *
 * Run via `pnpm --filter @yocore/api audit:indexes`.
 *
 * SAFETY: `syncIndexes()` will DROP indexes that are no longer declared in
 * the schema. Run against a NON-PROD database first; treat the diff as a
 * code-review checkpoint before applying to prod.
 */
import 'dotenv/config';
import mongoose from 'mongoose';

import * as registry from '../src/db/index.js';

async function main(): Promise<void> {
  const uri = process.env['MONGO_URL'] ?? 'mongodb://localhost:27017/yocore';
  // eslint-disable-next-line no-console
  console.log(`[audit-indexes] connecting to ${uri}`);
  await mongoose.connect(uri);

  const models = Object.values(registry).filter(
    (v): v is mongoose.Model<unknown> =>
      typeof v === 'function' && 'modelName' in v && 'collection' in v,
  );

  // eslint-disable-next-line no-console
  console.log(`[audit-indexes] found ${models.length} models\n`);

  for (const model of models) {
    const name = model.modelName;
    try {
      // eslint-disable-next-line no-console
      console.log(`── ${name} (${model.collection.name})`);
      await model.syncIndexes({ background: true });
      const indexes = await model.collection.getIndexes({ full: true });
      for (const idx of indexes as Array<{ name: string; key: Record<string, unknown> }>) {
        // eslint-disable-next-line no-console
        console.log(`   • ${idx.name.padEnd(40)} ${JSON.stringify(idx.key)}`);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`   ✗ failed for ${name}:`, (err as Error).message);
    }
  }

  await mongoose.disconnect();
  // eslint-disable-next-line no-console
  console.log('\n[audit-indexes] done');
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
