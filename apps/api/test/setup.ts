// Set env BEFORE any module imports it (logger reads env at module load).
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'fatal';
process.env.MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/yocore-test';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379/15';
process.env.YOCORE_KMS_KEY =
  process.env.YOCORE_KMS_KEY ??
  '0000000000000000000000000000000000000000000000000000000000000000';
process.env.BOOTSTRAP_SECRET =
  process.env.BOOTSTRAP_SECRET ?? 'test-bootstrap-secret-must-be-at-least-32-characters-long';
