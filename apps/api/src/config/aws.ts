import { S3Client } from '@aws-sdk/client-s3';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { KMSClient } from '@aws-sdk/client-kms';
import { env } from './env.js';

let s3: S3Client | undefined;
let sm: SecretsManagerClient | undefined;
let kms: KMSClient | undefined;

export function getS3(): S3Client {
  if (!s3) s3 = new S3Client({ region: env.AWS_REGION });
  return s3;
}

export function getSecretsManager(): SecretsManagerClient {
  if (!sm) sm = new SecretsManagerClient({ region: env.AWS_REGION });
  return sm;
}

export function getKMS(): KMSClient {
  if (!kms) kms = new KMSClient({ region: env.AWS_REGION });
  return kms;
}

export function destroyAwsClients(): void {
  s3?.destroy();
  sm?.destroy();
  kms?.destroy();
  s3 = undefined;
  sm = undefined;
  kms = undefined;
}
