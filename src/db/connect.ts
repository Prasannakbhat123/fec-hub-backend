import dns from 'node:dns';
import mongoose from 'mongoose';
import { env } from '../config/env.js';

dns.setDefaultResultOrder('ipv4first');
try {
  dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);
} catch {
  /* ignore */
}

export async function connectDb(): Promise<void> {
  if (!env.mongoUri) {
    throw new Error('MONGO_URI is required');
  }
  mongoose.set('strictQuery', true);
  const opts = { dbName: 'fechub', serverSelectionTimeoutMS: 25_000 } as const;

  try {
    await mongoose.connect(env.mongoUri, opts);
  } catch (err) {
    const direct = process.env.MONGO_URI_DIRECT;
    if (direct) {
      console.warn('[db] SRV connect failed, retrying MONGO_URI_DIRECT');
      await mongoose.connect(direct, opts);
    } else if (env.mongoUri.startsWith('mongodb+srv://') && env.mongoUri.includes('cluster0.c3gsjb3.mongodb.net')) {
      const credMatch = env.mongoUri.match(/^mongodb\+srv:\/\/([^@]+)@/);
      const creds = credMatch?.[1];
      if (!creds) throw err;
      const directUri =
        `mongodb://${creds}@` +
        `ac-p14kriq-shard-00-00.c3gsjb3.mongodb.net:27017,` +
        `ac-p14kriq-shard-00-01.c3gsjb3.mongodb.net:27017,` +
        `ac-p14kriq-shard-00-02.c3gsjb3.mongodb.net:27017` +
        `/?ssl=true&replicaSet=atlas-tiboo1-shard-0&authSource=admin&retryWrites=true&w=majority`;
      console.warn('[db] SRV failed, retrying direct Atlas hosts');
      await mongoose.connect(directUri, opts);
    } else {
      throw err;
    }
  }

  console.log('[db] connected to MongoDB (fechub)');
}
