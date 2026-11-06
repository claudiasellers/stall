export function log(scope: string, ...args: unknown[]) {
  console.log(new Date().toISOString(), `[${scope}]`, ...args);
}
