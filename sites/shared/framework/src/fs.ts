// Node "fs" and "path" compatibility shim using bext's native IO bridge.
// Import this module or alias "fs"/"path" to it in the Bun build config.

export function readFileSync(path: string, _encoding?: string): string {
  return __readFile(path);
}

export function readdirSync(path: string): string[] {
  return JSON.parse(__readDir(path));
}

export function existsSync(path: string): boolean {
  return __readFileExists(path);
}

export function join(...parts: string[]): string {
  return parts.join("/").replace(/\/+/g, "/");
}
