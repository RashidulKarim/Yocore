/**
 * JWT signing-key repository + JwtKeyring loader.
 *
 * The key material is stored encrypted at rest (envelope-encrypted via
 * `lib/encryption`). On load we decrypt the private JWK only for the active
 * key (the one used for signing); verifying-only keys keep the public JWK.
 */
import { JwtSigningKey } from '../db/models/JwtSigningKey.js';
import { decryptToString, encrypt } from '../lib/encryption.js';
import type { JwtKeyRecord, KeyLoader } from '../lib/jwt-keyring.js';
import { newId } from '../db/id.js';
import type { JWK } from 'jose';

export const jwtKeyringLoader: KeyLoader = async () => {
  const rows = await JwtSigningKey.find({ status: { $ne: 'retired' } })
    .sort({ activatedAt: -1 })
    .lean();

  return rows.map((row): JwtKeyRecord => {
    const publicJwk = JSON.parse(row.publicKey) as JWK;
    const rec: JwtKeyRecord = {
      kid: row._id,
      status: row.status as 'active' | 'verifying',
      alg: row.algorithm as JwtKeyRecord['alg'],
      publicJwk,
      ...(row.rotatedAt ? { rotatedAt: row.rotatedAt } : {}),
      ...(row.verifyUntil ? { verifyUntil: row.verifyUntil } : {}),
    };
    if (row.status === 'active') {
      rec.privateJwk = JSON.parse(decryptToString(row.privateKeyEncrypted)) as JWK;
    }
    return rec;
  });
};

export async function insertActiveKey(input: {
  alg: 'EdDSA' | 'RS256';
  publicJwk: JWK;
  privateJwk: JWK;
}): Promise<string> {
  const kid = newId('kid');
  await JwtSigningKey.create({
    _id: kid,
    algorithm: input.alg,
    publicKey: JSON.stringify(input.publicJwk),
    privateKeyEncrypted: encrypt(JSON.stringify(input.privateJwk)).token,
    status: 'active',
    activatedAt: new Date(),
  });
  return kid;
}
