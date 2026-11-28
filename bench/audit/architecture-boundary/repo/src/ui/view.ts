import { query } from "../data/db.js";

export function view(): unknown {
  return query();
}
