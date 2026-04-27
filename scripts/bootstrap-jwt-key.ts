/**
 * Bootstrap the initial JWT signing key (one-time).
 * Usage: pnpm --filter @yocore/api tsx ../../scripts/bootstrap-jwt-key.ts
 */
import { connectMongo } from '../apps/api/src/config/db.js';
import { insertActiveKey } from '../apps/api/src/repos/jwt-key.repo.js';
import { generateKeyPair, exportJWK, type JWK } from 'jose';

async function main() {
  await connectMongo();
  console.log('[bootstrap-jwt-key] Generating EdDSA keypair...');
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const privateJwk = await exportJWK(privateKey);
  
  console.log('[bootstrap-jwt-key] Inserting active key...');
  const kid = await insertActiveKey({
    alg: 'EdDSA',
    publicJwk: publicJwk as JWK,
    privateJwk: privateJwk as JWK,
  });
  console.log(`[bootstrap-jwt-key] ✅ JWT key created: ${kid}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('[bootstrap-jwt-key] ERROR:', err.message);
  process.exit(1);
});
