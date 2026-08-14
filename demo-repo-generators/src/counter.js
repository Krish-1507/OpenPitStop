// Module-level mutable state near async code — a race-condition heuristic smell.
// `pitstop scan` flags this; `pitstop repro` then pounds the exports.
let counter = 0;

export async function increment() {
  counter = await Promise.resolve(counter + 1);
  return counter;
}

export function reset() {
  counter = 0;
}

export function current() {
  return counter;
}
