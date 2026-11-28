import { readFileSync } from "node:fs";

const db = { findMany: async (_query: unknown) => [] as unknown[] };

export async function loadOther(req: any) {
  const items = req.items ?? [];
  for (const item of items) {
    await db.findMany({ id: item.id });
  }
  try {
    const raw = readFileSync("C:\\data\\config.json", "utf8");
    if (raw == null) {
      return [];
    }
    return raw as any;
  } catch (error) {}
}

export function helper() {
  return 1;
}
