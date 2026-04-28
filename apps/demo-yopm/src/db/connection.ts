/**
 * Dedicated Mongoose connection for the YoPM product database.
 *
 * This is a SEPARATE connection (and a separate database `yopm_demo`)
 * from the YoCore API. The product owns its application data here;
 * YoCore owns identity / billing / workspaces in its own DB.
 */
import mongoose, { type Connection } from 'mongoose';

let conn: Connection | null = null;

export async function connectYopmDb(uri: string): Promise<Connection> {
  if (conn && conn.readyState === 1) return conn;
  // eslint-disable-next-line no-console
  console.log(`[demo-yopm] connecting to product DB: ${uri.replace(/\/\/.*@/, '//***@')}`);
  conn = await mongoose
    .createConnection(uri, { serverSelectionTimeoutMS: 5000 })
    .asPromise();
  // eslint-disable-next-line no-console
  console.log(`[demo-yopm] product DB ready (db=${conn.name})`);
  return conn;
}

export function getYopmDb(): Connection {
  if (!conn) throw new Error('YoPM DB not initialised — call connectYopmDb() first');
  return conn;
}
