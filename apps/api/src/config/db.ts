import mongoose from 'mongoose';
import { env } from './env.js';
import { logger } from '../lib/logger.js';

mongoose.set('strictQuery', true);
mongoose.set('autoIndex', env.NODE_ENV !== 'production');

let connecting: Promise<typeof mongoose> | null = null;

export async function connectMongo(): Promise<typeof mongoose> {
  if (mongoose.connection.readyState === 1) return mongoose;
  if (connecting) return connecting;

  const opts: mongoose.ConnectOptions = {
    maxPoolSize: 50,
    minPoolSize: 5,
    serverSelectionTimeoutMS: 10_000,
    socketTimeoutMS: 45_000,
    retryWrites: true,
    ...(env.MONGODB_REPLICA_SET ? { replicaSet: env.MONGODB_REPLICA_SET } : {}),
  };

  connecting = mongoose.connect(env.MONGODB_URI, opts).then((m) => {
    logger.info({ event: 'mongo.connected' }, 'MongoDB connected');
    return m;
  });

  mongoose.connection.on('disconnected', () => {
    logger.warn({ event: 'mongo.disconnected' }, 'MongoDB disconnected');
  });
  mongoose.connection.on('reconnected', () => {
    logger.info({ event: 'mongo.reconnected' }, 'MongoDB reconnected');
  });
  mongoose.connection.on('error', (err) => {
    logger.error({ event: 'mongo.error', err }, 'MongoDB error');
  });

  try {
    await connecting;
  } catch (err) {
    connecting = null;
    throw err;
  }
  return mongoose;
}

export async function disconnectMongo(): Promise<void> {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
    connecting = null;
    logger.info({ event: 'mongo.closed' }, 'MongoDB connection closed');
  }
}
