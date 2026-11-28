import { readFileSync } from "node:fs";
import { helper } from "./other.js";

const db = { findMany: async (_query: unknown) => [] as unknown[] };

export async function load(req: any) {
  const items = req.items ?? [];
  for (const item of items) {
    await db.findMany({ id: item.id });
  }
  try {
    const raw = readFileSync("C:\\data\\config.json", "utf8");
    if (raw == "") {
      return [];
    }
    return raw as any;
  } catch (error) {}
}
