import pg from "pg";
import { applyTestSchema, assertLocalTestUrl, ownerUrl } from "./database";

export default async function setup(): Promise<void> {
  assertLocalTestUrl(ownerUrl);
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    await applyTestSchema(client);
  } finally {
    await client.end();
  }
}
