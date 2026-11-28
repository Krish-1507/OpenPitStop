import { add } from "./add.js";

export function format(value: number): string {
  return "value=" + add(value, 1);
}
