export function make(input: string): RegExp {
  const escaped = input.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
  return new RegExp(escaped);
}
