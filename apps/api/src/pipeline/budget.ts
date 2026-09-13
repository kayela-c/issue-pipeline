import type { TreeEntry } from "../forge/types";

/**
 * Prompt sizing for models with small context windows (local models). The
 * hosted models have room to spare, so without a context size these budgets
 * are not applied.
 *
 * Token counts are estimated, not measured: ~3 characters per token is
 * conservative for a mix of code, paths, and prose across tokenizers.
 */
export const CHARS_PER_TOKEN = 3;

export const estimateTokens = (text: string) => Math.ceil(text.length / CHARS_PER_TOKEN);

export interface FileListing {
  text: string;
  shown: number;
  total: number;
  /** "sizes": everything with sizes; "paths": everything, paths only; "ranked": the best matches only. */
  mode: "sizes" | "paths" | "ranked";
}

/** Lower-case words of 3+ letters or digits, splitting camelCase, snake_case, kebab-case, and paths. */
function words(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3);
}

/**
 * How strongly a path's names match the notes. Word stems are compared
 * loosely ("reset" matches "PasswordResetController"), and shallower paths
 * win ties because they tend to be entry points.
 */
function relevance(path: string, noteWords: Set<string>): number {
  let score = 0;
  for (const segment of words(path)) {
    for (const word of noteWords) {
      if (segment === word) score += 3;
      else if (segment.startsWith(word) || word.startsWith(segment)) score += 1;
    }
  }
  return score;
}

const PATH_LIKE = /[\w.@~-]*(?:\/[\w.@~*-]+)+\/?|[\w.-]+\.[a-z][a-z0-9]{0,5}\b/gi;

/**
 * Path-like references in a routing file, such as `app/Http/Controllers/Auth/`,
 * `routes/web.php`, or a glob like `src/components/*.tsx` (cut at the first
 * wildcard). Lower-cased, without a leading "./".
 */
export function routedPaths(routing: string): string[] {
  const found = routing.match(PATH_LIKE) ?? [];
  return [
    ...new Set(
      found
        .map((p) => p.split("*")[0]!.replace(/^\.?\//, "").toLowerCase())
        .filter((p) => p.length >= 3 && !p.startsWith("/")),
    ),
  ];
}

/** Whether a repository path is, or lives under, a path the routing file names. */
function isRouted(path: string, routed: string[]): boolean {
  const lower = path.toLowerCase();
  return routed.some(
    (r) => lower === r || lower.startsWith(r.endsWith("/") ? r : `${r}/`) || lower.endsWith(`/${r}`),
  );
}

/**
 * The file list for the selection prompt, within `maxChars`. Falls back from
 * paths-with-sizes to bare paths to the paths the routing file names plus the
 * best name matches for the notes, so a large repository still fits a small
 * model. The caller tells the model when the list is partial.
 */
export function renderFileList(files: TreeEntry[], notes: string, maxChars: number, routing = ""): FileListing {
  const total = files.length;
  const withSizes = files.map((f) => `${f.path} (${f.size} bytes)`).join("\n");
  if (withSizes.length <= maxChars) return { text: withSizes, shown: total, total, mode: "sizes" };

  const paths = files.map((f) => f.path).join("\n");
  if (paths.length <= maxChars) return { text: paths, shown: total, total, mode: "paths" };

  const noteWords = new Set(words(notes));
  const routed = routedPaths(routing);
  const ranked = files
    .map((f) => ({
      path: f.path,
      // Paths the routing file names outrank name matches alone.
      score: relevance(f.path, noteWords) + (isRouted(f.path, routed) ? 20 : 0),
      depth: f.path.split("/").length,
    }))
    .sort((a, b) => b.score - a.score || a.depth - b.depth || a.path.localeCompare(b.path));

  const kept: string[] = [];
  let length = 0;
  for (const { path } of ranked) {
    if (length + path.length + 1 > maxChars) continue;
    kept.push(path);
    length += path.length + 1;
  }
  kept.sort((a, b) => a.localeCompare(b));
  return { text: kept.join("\n"), shown: kept.length, total, mode: "ranked" };
}
