import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { extname, join, sep } from "node:path";

/**
 * Borrowed from paseo's project-icon detection: icon file patterns to
 * search for, in priority order. Patterns starting with '*' are glob
 * patterns (e.g., icon-*.png).
 *
 * SVG and PNG outrank ICO across all known names: every client renders them
 * and they scale better. ICO is the final fallback because native clients
 * cannot decode containers whose frames use the legacy bitmap format.
 */
export const PROJECT_ICON_PATTERNS = [
  "favicon.svg",
  "favicon.png",
  "favicon-*.svg",
  "favicon-*.png",
  "favico.svg",
  "favico.png",
  "icon.svg",
  "icon.png",
  "app-icon.svg",
  "app-icon.png",
  "apple-touch-icon.png",
  "apple-touch-icon-*.png",
  "icon-*.png",
  "android-chrome-*.png",
  "safari-pinned-tab.svg",
  "mstile-*.png",
  "logo.svg",
  "logo.png",
  "favicon.ico",
  "favico.ico",
];

/**
 * Directories or directory paths to search first (in priority order).
 */
export const PRIORITY_DIRS = ["public", "static", "priv/static", "assets", "images", "img"];

/**
 * Monorepo package directory patterns to scan (e.g., packages/app, apps/web).
 */
export const MONOREPO_PACKAGE_DIRS = ["packages", "apps"];

/**
 * Directories to ignore during search.
 */
export const IGNORED_DIRS = [
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".output",
  "coverage",
  ".cache",
  "vendor",
  "src",
  "lib",
  "test",
  "tests",
  "__tests__",
];

/**
 * Source roots whose asset subdirs are searched as a last resort (see
 * SRC_ASSET_SUBDIRS). Bundler-era apps often keep their served icons under
 * `src/assets`, which the filename walk ignores so component-asset SVGs
 * never shadow a real favicon.
 */
const SRC_ROOT_DIRS = ["src", "lib"];

/** Conventional asset subdirs to look inside each source root. */
const SRC_ASSET_SUBDIRS = ["assets", "public", "static", "images", "img"];

export interface DetectedProjectIcon {
  data: string;
  mimeType: string;
}

const MAX_ICON_SIZE = 32 * 1024; // 32KB max

export interface ImageDimensions {
  width: number;
  height: number;
}

function getPngDimensions(buffer: Buffer): ImageDimensions | null {
  // PNG header: 89 50 4E 47 0D 0A 1A 0A
  if (buffer.length < 24) return null;
  if (buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) {
    return null;
  }
  // Width and height are at bytes 16-19 and 20-23 (big endian)
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return { width, height };
}

function getJpegDimensions(buffer: Buffer): ImageDimensions | null {
  // JPEG starts with FF D8 FF
  if (buffer.length < 4) return null;
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;

  let offset = 2;
  while (offset < buffer.length - 8) {
    if (buffer[offset] !== 0xff) {
      offset++;
      continue;
    }

    const marker = buffer[offset + 1];
    // SOF0-SOF2 markers contain dimensions
    if (marker !== undefined && marker >= 0xc0 && marker <= 0xc2) {
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      return { width, height };
    }

    // Skip to next marker
    const length = buffer.readUInt16BE(offset + 2);
    offset += 2 + length;
  }
  return null;
}

function getGifDimensions(buffer: Buffer): ImageDimensions | null {
  // GIF header: GIF87a or GIF89a
  if (buffer.length < 10) return null;
  if (buffer[0] !== 0x47 || buffer[1] !== 0x49 || buffer[2] !== 0x46) return null;
  // Width and height at bytes 6-7 and 8-9 (little endian)
  const width = buffer.readUInt16LE(6);
  const height = buffer.readUInt16LE(8);
  return { width, height };
}

function getWebpDimensions(buffer: Buffer): ImageDimensions | null {
  // WEBP: RIFF....WEBP
  if (buffer.length < 30) return null;
  if (buffer.toString("ascii", 0, 4) !== "RIFF") return null;
  if (buffer.toString("ascii", 8, 12) !== "WEBP") return null;

  const chunkType = buffer.toString("ascii", 12, 16);
  if (chunkType === "VP8 ") {
    // Lossy format - dimensions at offset 26-27 and 28-29
    const width = buffer.readUInt16LE(26) & 0x3fff;
    const height = buffer.readUInt16LE(28) & 0x3fff;
    return { width, height };
  } else if (chunkType === "VP8L") {
    // Lossless format
    const bits = buffer.readUInt32LE(21);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    return { width, height };
  }
  return null;
}

export function getImageDimensions(buffer: Buffer, mimeType: string): ImageDimensions | null {
  switch (mimeType) {
    case "image/png":
      return getPngDimensions(buffer);
    case "image/jpeg":
      return getJpegDimensions(buffer);
    case "image/gif":
      return getGifDimensions(buffer);
    case "image/webp":
      return getWebpDimensions(buffer);
    case "image/x-icon":
      // ICO files are typically square, trust them
      return { width: 1, height: 1 };
    case "image/svg+xml":
      // SVG can be any aspect ratio but icons are typically square, trust them
      return { width: 1, height: 1 };
    default:
      return null;
  }
}

function isSquareImage(buffer: Buffer, mimeType: string): boolean {
  const dimensions = getImageDimensions(buffer, mimeType);
  if (!dimensions) return false;
  return dimensions.width === dimensions.height;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Detect the mime type from the file's magic bytes. Extensions lie: a large
 * share of real-world favicon.ico files are PNG data renamed, which browsers
 * render regardless — but clients key off the reported mime type, so
 * mislabelling them image/x-icon needlessly drops the icon there.
 */
function sniffMimeType(buffer: Buffer): string | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (buffer.length >= 6 && buffer.toString("ascii", 0, 3) === "GIF") {
    return "image/gif";
  }
  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  if (
    buffer.length >= 6 &&
    buffer.readUInt16LE(0) === 0 &&
    buffer.readUInt16LE(2) === 1 &&
    buffer.readUInt16LE(4) > 0
  ) {
    return "image/x-icon";
  }
  return null;
}

/**
 * ICO is a container; modern favicons usually carry a PNG-encoded frame for the
 * larger sizes. Some clients can't decode ICO but decode PNG fine, so when a
 * PNG frame exists, serve the largest one as image/png instead of the container.
 */
export function extractIcoPngFrame(buffer: Buffer): Buffer | null {
  if (buffer.length < 6 || buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1) {
    return null;
  }
  const frameCount = buffer.readUInt16LE(4);
  let best: Buffer | null = null;
  let bestWidth = -1;
  for (let index = 0; index < frameCount; index += 1) {
    const entryOffset = 6 + index * 16;
    if (entryOffset + 16 > buffer.length) {
      break;
    }
    // Directory entry: width(1) height(1) colors(1) reserved(1) planes(2)
    // bpp(2) dataSize(4 LE) dataOffset(4 LE). Width byte 0 means 256.
    const width = buffer[entryOffset] === 0 ? 256 : (buffer[entryOffset] ?? 0);
    const dataSize = buffer.readUInt32LE(entryOffset + 8);
    const dataOffset = buffer.readUInt32LE(entryOffset + 12);
    if (dataOffset + dataSize > buffer.length) {
      continue;
    }
    const frame = buffer.subarray(dataOffset, dataOffset + dataSize);
    if (frame.length >= 8 && frame.subarray(0, 8).equals(PNG_SIGNATURE) && width > bestWidth) {
      best = frame;
      bestWidth = width;
    }
  }
  return best;
}

function getMimeType(filename: string): string {
  const ext = extname(filename).toLowerCase();
  switch (ext) {
    case ".ico":
      return "image/x-icon";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

function matchesPattern(filename: string, pattern: string): boolean {
  if (pattern.includes("*")) {
    // Convert glob pattern to regex
    const regexPattern = pattern.replace(/\./g, "\\.").replace(/\*/g, ".*");
    return new RegExp(`^${regexPattern}$`).test(filename);
  }
  return filename === pattern;
}

async function isExistingFile(fullPath: string): Promise<boolean> {
  try {
    const stats = await stat(fullPath);
    return stats.isFile();
  } catch {
    return false;
  }
}

async function isExistingDirectory(fullPath: string): Promise<boolean> {
  try {
    const stats = await stat(fullPath);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

async function findIconsInDir(dir: string, patterns: string[]): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  // Candidate paths in priority order (pattern, then entry), deduplicated.
  const seen = new Set<string>();
  const candidatePaths: string[] = [];
  for (const pattern of patterns) {
    for (const entry of entries) {
      if (matchesPattern(entry, pattern)) {
        const fullPath = join(dir, entry);
        if (!seen.has(fullPath)) {
          seen.add(fullPath);
          candidatePaths.push(fullPath);
        }
      }
    }
  }

  const existsResults = await Promise.all(candidatePaths.map((p) => isExistingFile(p)));
  return candidatePaths.filter((_, index) => existsResults[index]);
}

async function findIconInDir(dir: string, patterns: string[]): Promise<string | null> {
  const matches = await findIconsInDir(dir, patterns);
  return matches[0] ?? null;
}

async function collectPriorityDirIcons(
  basePath: string,
  ignoredDirsSet: Set<string>,
  remainingDepth: number,
): Promise<string[]> {
  const priorityPaths = PRIORITY_DIRS.map((priorityDir) => join(basePath, priorityDir));
  const existenceResults = await Promise.all(
    priorityPaths.map((priorityPath) => isExistingDirectory(priorityPath)),
  );
  const searchResults = await Promise.all(
    priorityPaths.map((priorityPath, index) =>
      existenceResults[index]
        ? collectDirIconsRecursively(priorityPath, PROJECT_ICON_PATTERNS, ignoredDirsSet, remainingDepth)
        : Promise.resolve([] as string[]),
    ),
  );
  return searchResults.flat();
}

async function collectDirIconsRecursively(
  dir: string,
  patterns: string[],
  ignoredDirs: Set<string>,
  maxDepth: number,
  currentDepth: number = 0,
): Promise<string[]> {
  if (currentDepth > maxDepth) {
    return [];
  }

  // First this directory's icons, then subdirectories in entry order.
  const found = await findIconsInDir(dir, patterns);

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return found;
  }

  const candidatePaths = entries
    .filter((entry) => !ignoredDirs.has(entry))
    .map((entry) => join(dir, entry));
  const isDirResults = await Promise.all(
    candidatePaths.map((fullPath) => isExistingDirectory(fullPath)),
  );
  const recursionResults = await Promise.all(
    candidatePaths.map((fullPath, index) =>
      isDirResults[index]
        ? collectDirIconsRecursively(fullPath, patterns, ignoredDirs, maxDepth, currentDepth + 1)
        : Promise.resolve([] as string[]),
    ),
  );
  return [...found, ...recursionResults.flat()];
}

/**
 * HTML-declared icon detection. The filename walk below ignores `src/` (and
 * `lib/`) so component-asset SVGs never shadow a real favicon — but that
 * also hides legitimate app icons such as `src/web/icon.svg`. Those icons
 * are always referenced explicitly from their page's `<link rel="icon">`
 * (and often a web-manifest), so resolve them directly from the markup
 * instead of opening the whole `src/` tree to filename matching.
 */

/** `src`/`lib` hold app code, not vendored assets: allow them here only. */
const HTML_SEARCH_IGNORED_DIRS = IGNORED_DIRS.filter((dir) => dir !== "src" && dir !== "lib");

const MANIFEST_FILENAMES = ["manifest.webmanifest", "manifest.json", "site.webmanifest"];

const MAX_HTML_FILES = 10;
const MAX_HTML_SIZE = 256 * 1024; // 256KB max per HTML/manifest file

/** Extract `href`s from `<link>` tags whose `rel` contains "icon". */
export function extractHtmlIconHrefs(html: string): string[] {
  const hrefs: string[] = [];
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    const rel = tag.match(/\brel\s*=\s*["']([^"']*)["']/i)?.[1];
    if (!rel || !rel.toLowerCase().includes("icon")) continue;
    const href = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
    if (href) hrefs.push(href);
  }
  return hrefs;
}

/** Extract the web-manifest `href` from `<link rel="manifest">`, if any. */
export function extractHtmlManifestHref(html: string): string | null {
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    const rel = tag.match(/\brel\s*=\s*["']([^"']*)["']/i)?.[1];
    if (!rel || rel.trim().toLowerCase() !== "manifest") continue;
    const href = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
    if (href) return href;
  }
  return null;
}

/** Extract icon `src`s from a web-manifest JSON document. */
export function extractManifestIconSrcs(manifestText: string): string[] {
  try {
    const parsed: unknown = JSON.parse(manifestText);
    if (typeof parsed !== "object" || parsed === null) return [];
    const icons = (parsed as { icons?: unknown }).icons;
    if (!Array.isArray(icons)) return [];
    const srcs: string[] = [];
    for (const entry of icons) {
      if (typeof entry === "string") {
        srcs.push(entry);
      } else if (typeof entry === "object" && entry !== null) {
        const src = (entry as { src?: unknown }).src;
        if (typeof src === "string") srcs.push(src);
      }
    }
    return srcs;
  } catch {
    return [];
  }
}

/** Strip query/hash; return null for remote, data:, or empty references. */
function cleanIconRef(ref: string): string | null {
  const trimmed = ref.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const lower = trimmed.toLowerCase();
  if (
    lower.startsWith("http://") ||
    lower.startsWith("https://") ||
    lower.startsWith("//") ||
    lower.startsWith("data:") ||
    lower.startsWith("blob:")
  ) {
    return null;
  }
  const withoutQuery = trimmed.split(/[?#]/)[0]?.trim();
  return withoutQuery ? withoutQuery : null;
}

/**
 * Resolve an HTML/manifest-relative icon reference to on-disk candidates.
 * Absolute (`/icon.svg`) references are serve-root-relative: the file may
 * live in `public/`, `src/web/`, `src/`, or the project root, so try each.
 * Relative references resolve against the referencing file's directory.
 */
function resolveIconRefCandidates(ref: string, baseDir: string, projectDir: string): string[] {
  const cleaned = cleanIconRef(ref);
  if (!cleaned) return [];
  if (cleaned.startsWith("/")) {
    const rel = cleaned.slice(1);
    if (!rel) return [];
    return [
      join(projectDir, "public", rel),
      join(projectDir, "src", "web", rel),
      join(projectDir, "src", rel),
      join(projectDir, rel),
      join(baseDir, rel),
    ];
  }
  return [join(baseDir, cleaned)];
}

async function findIndexHtmlFiles(projectDir: string, maxDepth: number): Promise<string[]> {
  const ignored = new Set(HTML_SEARCH_IGNORED_DIRS);
  const found: string[] = [];
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth || found.length >= MAX_HTML_FILES) return;
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    if (entries.includes("index.html")) {
      const fullPath = join(dir, "index.html");
      if (await isExistingFile(fullPath)) found.push(fullPath);
    }
    const subdirs = entries.filter((entry) => !ignored.has(entry)).map((entry) => join(dir, entry));
    const isDirResults = await Promise.all(subdirs.map((p) => isExistingDirectory(p)));
    for (let i = 0; i < subdirs.length; i += 1) {
      if (isDirResults[i] && found.length < MAX_HTML_FILES) {
        const sub = subdirs[i];
        if (sub) await visit(sub, depth + 1);
      }
    }
  };
  await visit(projectDir, 0);
  // Shallow pages first: the top-level app shell outranks nested demos.
  found.sort((a, b) => a.length - b.length);
  return found;
}

async function readIfSmall(path: string): Promise<string | null> {
  try {
    const stats = await stat(path);
    if (!stats.isFile() || stats.size > MAX_HTML_SIZE) return null;
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Icon files declared by `<link rel="icon">` / web-manifests, best first.
 * Returned paths may not exist — `getProjectIcon` validates each candidate
 * (existence, size, squareness, root containment) before use.
 */
async function collectDeclaredIconCandidates(
  projectDir: string,
  maxDepth: number,
): Promise<string[]> {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const push = (path: string) => {
    if (!seen.has(path)) {
      seen.add(path);
      candidates.push(path);
    }
  };
  const pushManifestIcons = async (manifestPath: string, manifestDir: string) => {
    const text = await readIfSmall(manifestPath);
    if (text === null) return;
    for (const src of extractManifestIconSrcs(text)) {
      for (const candidate of resolveIconRefCandidates(src, manifestDir, projectDir)) {
        push(candidate);
      }
    }
  };

  const htmlFiles = await findIndexHtmlFiles(projectDir, maxDepth);
  for (const htmlFile of htmlFiles) {
    const text = await readIfSmall(htmlFile);
    if (text === null) continue;
    const baseDir = join(htmlFile, "..");
    for (const href of extractHtmlIconHrefs(text)) {
      for (const candidate of resolveIconRefCandidates(href, baseDir, projectDir)) {
        push(candidate);
      }
    }
    const manifestHref = extractHtmlManifestHref(text);
    if (manifestHref) {
      for (const manifestPath of resolveIconRefCandidates(manifestHref, baseDir, projectDir)) {
        if (await isExistingFile(manifestPath)) {
          await pushManifestIcons(manifestPath, join(manifestPath, ".."));
          break;
        }
      }
    }
  }

  // Fallback for manifests with no referencing page found (e.g. the HTML
  // itself lives deeper than maxDepth): check conventional locations.
  if (candidates.length === 0) {
    const bases = [projectDir, join(projectDir, "public"), join(projectDir, "src", "web"), join(projectDir, "src")];
    for (const base of bases) {
      for (const name of MANIFEST_FILENAMES) {
        const manifestPath = join(base, name);
        if (await isExistingFile(manifestPath)) {
          await pushManifestIcons(manifestPath, base);
          if (candidates.length > 0) break;
        }
      }
      if (candidates.length > 0) break;
    }
  }

  const existing = await Promise.all(candidates.map((p) => isExistingFile(p)));
  return candidates.filter((_, index) => existing[index]);
}

/**
 * Find project icon/favicon candidates in the given directory, in priority
 * order: HTML/manifest-declared icons first, then priority dirs, then
 * monorepo package dirs, then the root fallback scan. Callers validate each
 * candidate (size, shape) and use the first usable one, so an unusable
 * higher-priority file does not shadow a valid lower-priority one.
 *
 * @param projectDir - The root directory of the project to search
 * @param maxDepth - Maximum depth below projectDir to descend (default: 3).
 *   Root-level files are depth 0.
 * @returns Absolute paths to candidate icons, best first (possibly empty)
 */
export async function findProjectIcons(
  projectDir: string,
  maxDepth: number = 3,
): Promise<string[]> {
  // Explicit `<link rel="icon">` / manifest references outrank filename
  // guesses: they are the icon the app actually serves (and the only
  // signal when the icon lives under an ignored dir such as `src/`).
  const declaredMatches = await collectDeclaredIconCandidates(projectDir, maxDepth);

  const ignoredDirsSet = new Set(IGNORED_DIRS);

  // First search priority directories
  const priorityMatches = await collectPriorityDirIcons(projectDir, ignoredDirsSet, maxDepth - 1);

  // Then search monorepo package directories (packages/*, apps/*).
  // Package roots sit at depth 1, so they are out of reach when maxDepth < 1.
  let monoMatches: string[] = [];
  if (maxDepth >= 1) {
    const monoPaths = MONOREPO_PACKAGE_DIRS.map((monoDir) => join(projectDir, monoDir));
    const monoEntries = await Promise.all(
      monoPaths.map(async (monoPath): Promise<string[] | null> => {
        try {
          return await readdir(monoPath);
        } catch {
          return null;
        }
      }),
    );
    const monoResults = await Promise.all(
      monoPaths.map(async (monoPath, monoIdx): Promise<string[]> => {
        const packageEntries = monoEntries[monoIdx];
        if (!packageEntries) return [];
        const packagePaths = packageEntries.map((packageName) => join(monoPath, packageName));
        const isDirResults = await Promise.all(
          packagePaths.map((packagePath) => isExistingDirectory(packagePath)),
        );
        const packageResults = await Promise.all(
          packagePaths.map(async (packagePath, idx): Promise<string[]> => {
            if (!isDirResults[idx]) return [];
            // Package priority dirs outrank package root files (same name
            // priority as the top-level search), even though they sit deeper.
            const here = await findIconsInDir(packagePath, PROJECT_ICON_PATTERNS);
            const nested = maxDepth >= 2
              ? await collectPriorityDirIcons(packagePath, ignoredDirsSet, maxDepth - 2)
              : [];
            return [...nested, ...here];
          }),
        );
        return packageResults.flat();
      }),
    );
    monoMatches = monoResults.flat();
  }

  // Then search root and any other non-priority directories
  const rootMatches = await collectRootIcons(projectDir, maxDepth);

  // Source-tree asset dirs (e.g. packages/app/src/assets) last: bundler-era
  // apps keep their served icons under src/, which the filename walk above
  // ignores so component SVGs never shadow a real favicon. Only the
  // conventional asset subdirs are searched, and only after every
  // higher-confidence branch, so projects that already resolve keep their
  // existing result. Explicit well-known paths, not a tree walk, so depth
  // beyond "root files only" (maxDepth 0) is enough to allow them.
  const srcAssetMatches = maxDepth >= 1 ? await collectSrcAssetIcons(projectDir) : [];

  const seen = new Set(declaredMatches);
  const rest = [...priorityMatches, ...monoMatches, ...rootMatches, ...srcAssetMatches].filter((p) => {
    if (seen.has(p)) return false;
    seen.add(p);
    return true;
  });
  return [...declaredMatches, ...rest];
}

/**
 * Find a project icon/favicon in the given directory: the first candidate
 * from findProjectIcons, or null if there are none. Prefers icons declared
 * by `<link rel="icon">` / web-manifests, then falls back to filename
 * matching — use getProjectIcon to get a validated, readable icon.
 */
export async function findProjectIcon(
  projectDir: string,
  maxDepth: number = 3,
): Promise<string | null> {
  const matches = await findProjectIcons(projectDir, maxDepth);
  return matches[0] ?? null;
}

/**
 * Last-resort icon search inside source-tree asset dirs: `<base>/src/assets`,
 * `<base>/lib/public`, etc., where `<base>` is the project root plus each
 * monorepo package root. Only the conventional asset subdirs are listed
 * (never the source root itself), so component files like
 * `src/components/icon.svg` still cannot shadow a real favicon.
 */
async function collectSrcAssetIcons(projectDir: string): Promise<string[]> {
  const bases = [projectDir];
  for (const monoDir of MONOREPO_PACKAGE_DIRS) {
    let entries: string[];
    try {
      entries = await readdir(join(projectDir, monoDir));
    } catch {
      continue;
    }
    const packagePaths = entries.map((entry) => join(projectDir, monoDir, entry));
    const isDirResults = await Promise.all(packagePaths.map((p) => isExistingDirectory(p)));
    packagePaths.forEach((packagePath, index) => {
      if (isDirResults[index]) bases.push(packagePath);
    });
  }
  const assetDirs = bases.flatMap((base) =>
    SRC_ROOT_DIRS.flatMap((srcRoot) => SRC_ASSET_SUBDIRS.map((sub) => join(base, srcRoot, sub))),
  );
  const results = await Promise.all(
    assetDirs.map((dir) => findIconsInDir(dir, PROJECT_ICON_PATTERNS)),
  );
  return results.flat();
}

async function collectRootIcons(
  dir: string,
  maxDepth: number,
  currentDepth: number = 0,
): Promise<string[]> {
  const ignoredDirsSet = new Set(IGNORED_DIRS);
  // Priority and monorepo dirs were already searched above; skip them here.
  const searchedDirsSet = new Set([...PRIORITY_DIRS, ...MONOREPO_PACKAGE_DIRS]);

  if (currentDepth > maxDepth) {
    return [];
  }

  // Check this directory for icons
  const found = await findIconsInDir(dir, PROJECT_ICON_PATTERNS);

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return found;
  }

  const candidatePaths = entries
    .filter((entry) => !ignoredDirsSet.has(entry) && !searchedDirsSet.has(entry))
    .map((entry) => join(dir, entry));
  const isDirResults = await Promise.all(
    candidatePaths.map((fullPath) => isExistingDirectory(fullPath)),
  );
  const recursionResults = await Promise.all(
    candidatePaths.map((fullPath, index) =>
      isDirResults[index]
        ? collectRootIcons(fullPath, maxDepth, currentDepth + 1)
        : Promise.resolve([] as string[]),
    ),
  );
  return [...found, ...recursionResults.flat()];
}

/**
 * Find and read a project icon/favicon, returning it as base64.
 * Tries every filename candidate in priority order and returns the first
 * one that is readable, within the size cap, and square — so an unusable
 * higher-priority file never shadows a valid lower-priority one.
 * Symlinked candidates are resolved and must stay beneath the canonical
 * project root; escapes are skipped so a crafted link cannot exfiltrate
 * arbitrary daemon-readable files through the icon endpoint.
 *
 * @param projectDir - The root directory of the project to search
 * @returns The icon data with mime type, or null if not found
 */
export async function getProjectIcon(projectDir: string): Promise<DetectedProjectIcon | null> {
  let root: string;
  try {
    root = await realpath(projectDir);
  } catch {
    return null;
  }
  for (const candidate of await findProjectIcons(projectDir)) {
    let resolved: string;
    try {
      resolved = await realpath(candidate);
    } catch {
      continue;
    }
    if (resolved !== root && !resolved.startsWith(root + sep)) {
      continue;
    }
    try {
      const stats = await stat(resolved);
      if (!stats.isFile() || stats.size > MAX_ICON_SIZE) {
        continue;
      }

      const fileBuffer = await readFile(resolved);
      let mimeType = sniffMimeType(fileBuffer) ?? getMimeType(resolved);
      let buffer: Buffer = fileBuffer;
      if (mimeType === "image/x-icon") {
        const pngFrame = extractIcoPngFrame(fileBuffer);
        if (pngFrame) {
          buffer = pngFrame;
          mimeType = "image/png";
        }
      }

      // Only return square images
      if (!isSquareImage(buffer, mimeType)) {
        continue;
      }

      return { data: buffer.toString("base64"), mimeType };
    } catch {
      continue;
    }
  }
  return null;
}
