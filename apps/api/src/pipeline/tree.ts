import type { TreeEntry } from "../forge/types";

/** Files larger than this are never offered to the model. */
export const MAX_FILE_BYTES = 200 * 1024;

const EXCLUDED_DIRS = new Set(["node_modules", "dist", "build", ".git", "vendor"]);

const LOCKFILES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "deno.lock",
  "composer.lock",
  "Gemfile.lock",
  "Cargo.lock",
  "poetry.lock",
  "Pipfile.lock",
  "uv.lock",
  "go.sum",
  "mix.lock",
  "pubspec.lock",
  "packages.lock.json",
]);

const BINARY_EXTENSIONS = new Set([
  // images
  "png", "jpg", "jpeg", "gif", "bmp", "ico", "icns", "webp", "avif", "tif", "tiff", "psd", "heic",
  // audio / video
  "mp3", "wav", "ogg", "flac", "m4a", "aac", "mp4", "mov", "avi", "mkv", "webm",
  // fonts
  "woff", "woff2", "ttf", "otf", "eot",
  // archives and packages
  "zip", "gz", "tgz", "bz2", "xz", "7z", "rar", "tar", "jar", "war", "whl", "nupkg", "apk", "dmg", "msi", "deb", "rpm",
  // compiled and binary data
  "exe", "dll", "so", "dylib", "a", "o", "obj", "class", "pyc", "wasm", "bin", "dat", "db", "sqlite", "sqlite3", "pdb",
  // documents
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  // minified bundles and source maps
  "map",
]);

function extension(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** Whether a repo file is worth showing to the model at all. */
export function isRelevantFile(entry: TreeEntry): boolean {
  if (entry.size > MAX_FILE_BYTES) return false;
  const segments = entry.path.split("/");
  const base = segments[segments.length - 1] ?? "";
  if (segments.slice(0, -1).some((dir) => EXCLUDED_DIRS.has(dir))) return false;
  if (LOCKFILES.has(base)) return false;
  if (base.endsWith(".min.js") || base.endsWith(".min.css")) return false;
  return !BINARY_EXTENSIONS.has(extension(entry.path));
}

export function filterTree(entries: TreeEntry[]): TreeEntry[] {
  return entries.filter(isRelevantFile).sort((a, b) => a.path.localeCompare(b.path));
}

/** ROUTING.md at the repository root (any letter case), if any. */
export function findRouting(entries: TreeEntry[]): TreeEntry | undefined {
  return entries.find((e) => !e.path.includes("/") && e.path.toLowerCase() === "routing.md");
}

/** The first README at the repository root, if any. */
export function findReadme(entries: TreeEntry[]): TreeEntry | undefined {
  return entries
    .filter((e) => !e.path.includes("/") && /^readme(\.|$)/i.test(e.path))
    .sort((a, b) => a.path.length - b.path.length)[0];
}
