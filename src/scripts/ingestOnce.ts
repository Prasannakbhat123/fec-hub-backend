import { connectDb } from '../db/connect.js';
import { runIngestOnce } from '../services/feeds/runner.js';

async function main() {
  await connectDb();
  const result = await runIngestOnce();
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
