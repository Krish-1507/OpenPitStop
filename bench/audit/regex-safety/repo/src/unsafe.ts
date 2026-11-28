export function match(input: string): boolean {
  return /^(a+)+$/.test(input);
}
