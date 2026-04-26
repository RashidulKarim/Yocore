# Runbook — JWT Signing Key Compromise

**Severity:** P0 (every issued token is suspect)
**Trigger:** Suspected key leak (private key found in logs / git / external dump / disgruntled employee)

## Immediate action (within 15 minutes)

1. **Force key rotation:**
   ```
   POST /v1/admin/jwt/rotate-key  (Super Admin)
   ```
   This:
   - Generates a new keypair
   - Inserts as `status:"active"`
   - Old active key → `status:"verifying"` with `verifyUntil: now + 30m`
2. **Reduce verifyUntil to 0** (immediate retire — emergency mode):
   ```js
   db.jwtSigningKeys.updateOne(
     { _id: "kid_compromised_..." },
     { $set: { status: "retired", retiredAt: new Date(), verifyUntil: new Date() } }
   );
   ```
3. **Publish keyring reload to all instances:**
   ```bash
   redis-cli PUBLISH keyring:reload "{}"
   ```
   Within 60s, every API node has updated in-memory keyring.
4. **Revoke all active sessions** (force re-login for everyone):
   ```js
   db.sessions.updateMany(
     { revokedAt: null },
     { $set: { revokedAt: new Date(), revokedReason: "key_compromise" } }
   );
   ```
   Optionally narrow scope (only sessions issued after suspected leak time).

## After the dust settles

- All users will be logged out + must re-authenticate.
- MFA-enabled users get TOTP prompt.
- No JWT signed with compromised key will verify (since retired immediately).
- Webhook signatures unaffected (different secret).

## Post-incident actions

1. **Confirm leak source** (audit logs, git history, log redaction misses).
2. **Rotate dependent secrets:**
   - `YOCORE_KMS_KEY` (envelope re-encryption Lambda)
   - All product `apiSecret`s (notify products, give 24h grace)
   - All product `webhookSecret`s (use Flow AJ rotation)
3. **Scan all log archives** in S3 for signed JWTs (presence indicates redaction failure).
4. **Update Pino redaction list** to catch the leak pattern.
5. **Post-mortem within 5 business days.**

## Prevention (always-on)

- JWT private key is **only** in `jwtSigningKeys.privateKeyEncrypted` (AES-256-GCM with KMS DEK).
- Decrypted in memory only at sign time; never logged.
- Pino redaction list includes: `privateKey`, `private_key`, `secretKey`, `password`, `passwordHash`, `apiSecret`, `webhookSecret`, `Authorization`, `cookie`, `set-cookie`, `tokenHash`, `refreshToken`, `accessToken`, `bearer`, `recoveryCode`, `mfaSecret`.
- CI runs `truffleHog` against repo on every PR.
- `pnpm audit` weekly to catch vulnerable JWT libs.
