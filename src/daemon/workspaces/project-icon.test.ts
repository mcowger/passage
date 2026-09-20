import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractHtmlIconHrefs,
  extractHtmlManifestHref,
  extractManifestIconSrcs,
  extractIcoPngFrame,
  findProjectIcon,
  getProjectIcon,
} from "./project-icon.ts";

/** Minimal 1x1 PNG (square) with the IHDR width/height patched in. */
function png(width: number, height: number): Buffer {
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

/** Minimal ICO container wrapping PNG frames. Width byte 0 means 256. */
function ico(frames: { width: number; data: Buffer }[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  const entries = Buffer.alloc(16 * frames.length);
  let offset = 6 + entries.length;
  frames.forEach((frame, index) => {
    const base = index * 16;
    entries[base] = frame.width === 256 ? 0 : frame.width;
    entries[base + 1] = frame.width === 256 ? 0 : frame.width;
    entries.writeUInt32LE(frame.data.length, base + 8);
    entries.writeUInt32LE(offset, base + 12);
    offset += frame.data.length;
  });
  return Buffer.concat([header, entries, ...frames.map((f) => f.data)]);
}

async function makeRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "passage-project-icon-test-"));
}

describe("findProjectIcon", () => {
  test("finds a favicon in a priority dir", async () => {
    const root = await makeRoot();
    try {
      await mkdir(join(root, "public"), { recursive: true });
      await writeFile(join(root, "public", "favicon.svg"), "<svg></svg>");
      expect(await findProjectIcon(root)).toBe(join(root, "public", "favicon.svg"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("prefers svg over ico in the same dir", async () => {
    const root = await makeRoot();
    try {
      await mkdir(join(root, "public"), { recursive: true });
      await writeFile(join(root, "public", "favicon.ico"), ico([{ width: 16, data: png(16, 16) }]));
      await writeFile(join(root, "public", "favicon.svg"), "<svg></svg>");
      expect(await findProjectIcon(root)).toBe(join(root, "public", "favicon.svg"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("ignores node_modules", async () => {
    const root = await makeRoot();
    try {
      await mkdir(join(root, "node_modules", "some-package"), { recursive: true });
      await writeFile(join(root, "node_modules", "some-package", "favicon.png"), png(16, 16));
      expect(await findProjectIcon(root)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("finds icons in monorepo package dirs", async () => {
    const root = await makeRoot();
    try {
      await mkdir(join(root, "packages", "web", "public"), { recursive: true });
      await writeFile(join(root, "packages", "web", "public", "icon.png"), png(32, 32));
      expect(await findProjectIcon(root)).toBe(join(root, "packages", "web", "public", "icon.png"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("returns null when no icon exists", async () => {
    const root = await makeRoot();
    try {
      await writeFile(join(root, "README.md"), "# nothing here");
      expect(await findProjectIcon(root)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test("finds icons in non-priority nested directories", async () => {
    const root = await makeRoot();
    try {
      await mkdir(join(root, "brand", "nested"), { recursive: true });
      await writeFile(join(root, "brand", "nested", "icon.svg"), "<svg></svg>");
      expect(await findProjectIcon(root)).toBe(join(root, "brand", "nested", "icon.svg"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("honors maxDepth across every search branch", async () => {    const root = await makeRoot();
    try {
      await mkdir(join(root, "brand"), { recursive: true });
      await writeFile(join(root, "brand", "icon.svg"), "<svg></svg>");
      await mkdir(join(root, "packages", "web", "public"), { recursive: true });
      await writeFile(join(root, "packages", "web", "public", "icon.png"), png(32, 32));
      // Depth 0 sees root files only.
      await writeFile(join(root, "logo.png"), png(16, 16));
      expect(await findProjectIcon(root, 0)).toBe(join(root, "logo.png"));
      await rm(join(root, "logo.png"));
      expect(await findProjectIcon(root, 0)).toBeNull();
      // Default depth still reaches nested and monorepo icons.
      expect(await findProjectIcon(root)).toBe(join(root, "packages", "web", "public", "icon.png"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("getProjectIcon", () => {
  test("returns base64 data with mime type", async () => {
    const root = await makeRoot();
    try {
      await mkdir(join(root, "public"), { recursive: true });
      const data = png(32, 32);
      await writeFile(join(root, "public", "favicon.png"), data);
      const icon = await getProjectIcon(root);
      expect(icon?.mimeType).toBe("image/png");
      expect(icon?.data).toBe(data.toString("base64"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("sniffs png data mislabelled as .ico", async () => {
    const root = await makeRoot();
    try {
      const data = png(16, 16);
      await writeFile(join(root, "favicon.ico"), data);
      const icon = await getProjectIcon(root);
      expect(icon?.mimeType).toBe("image/png");
      expect(icon?.data).toBe(data.toString("base64"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("serves the largest png frame from an ico container", async () => {
    const small = png(16, 16);
    const large = png(32, 32);
    const frame = extractIcoPngFrame(ico([{ width: 16, data: small }, { width: 32, data: large }]));
    expect(frame?.equals(large)).toBe(true);
  });

  test("rejects non-square images", async () => {
    const root = await makeRoot();
    try {
      await mkdir(join(root, "public"), { recursive: true });
      await writeFile(join(root, "public", "logo.png"), png(32, 16));
      expect(await getProjectIcon(root)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects oversized files", async () => {
    const root = await makeRoot();
    try {
      await writeFile(join(root, "favicon.png"), Buffer.alloc(33 * 1024, 0));
      expect(await getProjectIcon(root)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("falls through to a valid lower-priority candidate", async () => {
    const root = await makeRoot();
    try {
      await mkdir(join(root, "public"), { recursive: true });
      await writeFile(join(root, "public", "favicon.svg"), Buffer.alloc(33 * 1024, 0));
      const data = png(16, 16);
      await writeFile(join(root, "public", "favicon.png"), data);
      const icon = await getProjectIcon(root);
      expect(icon?.mimeType).toBe("image/png");
      expect(icon?.data).toBe(data.toString("base64"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("skips symlinks escaping the project root", async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    try {
      const secret = png(16, 16);
      await writeFile(join(outside, "secret.png"), secret);
      await mkdir(join(root, "public"), { recursive: true });
      await symlink(join(outside, "secret.png"), join(root, "public", "favicon.svg"));
      // The escape is skipped: no usable icon remains.
      expect(await getProjectIcon(root)).toBeNull();
      // A valid lower-priority file is used instead of the escape.
      const data = png(32, 32);
      await writeFile(join(root, "public", "favicon.png"), data);
      const icon = await getProjectIcon(root);
      expect(icon?.mimeType).toBe("image/png");
      expect(icon?.data).toBe(data.toString("base64"));
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("declared icons (index.html / manifest)", () => {
  test("finds an icon under src/ declared by index.html", async () => {
    // Passage layout: src/web/index.html references ./icon.svg, but `src/`
    // is ignored by the filename walk.
    const root = await makeRoot();
    try {
      await mkdir(join(root, "src", "web"), { recursive: true });
      await writeFile(
        join(root, "src", "web", "index.html"),
        '<link rel="icon" type="image/svg+xml" href="./icon.svg" />',
      );
      await writeFile(join(root, "src", "web", "icon.svg"), "<svg></svg>");
      expect(await findProjectIcon(root)).toBe(join(root, "src", "web", "icon.svg"));
      const icon = await getProjectIcon(root);
      expect(icon?.mimeType).toBe("image/svg+xml");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("declared icon outranks filename matches", async () => {
    const root = await makeRoot();
    try {
      await mkdir(join(root, "public"), { recursive: true });
      await writeFile(join(root, "public", "favicon.png"), png(16, 16));
      await mkdir(join(root, "src", "web"), { recursive: true });
      const declared = png(32, 32);
      await writeFile(join(root, "src", "web", "app.png"), declared);
      await writeFile(
        join(root, "src", "web", "index.html"),
        '<link rel="icon" href="./app.png" />',
      );
      expect(await findProjectIcon(root)).toBe(join(root, "src", "web", "app.png"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("absolute href resolves into public/", async () => {
    const root = await makeRoot();
    try {
      await mkdir(join(root, "public"), { recursive: true });
      const data = png(16, 16);
      await writeFile(join(root, "public", "icon.svg"), "<svg></svg>");
      await writeFile(join(root, "index.html"), '<link rel="icon" href="/icon.svg" />');
      expect(await findProjectIcon(root)).toBe(join(root, "public", "icon.svg"));
      expect((await getProjectIcon(root))?.mimeType).toBe("image/svg+xml");
      await writeFile(join(root, "public", "icon.svg"), data);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("manifest icons are used via the manifest link", async () => {
    const root = await makeRoot();
    try {
      await mkdir(join(root, "src", "web"), { recursive: true });
      const data = png(32, 32);
      await writeFile(join(root, "src", "web", "icon-512.png"), data);
      await writeFile(
        join(root, "src", "web", "manifest.webmanifest"),
        JSON.stringify({ icons: [{ src: "./icon-512.png", sizes: "512x512" }] }),
      );
      await writeFile(
        join(root, "src", "web", "index.html"),
        '<link rel="manifest" href="./manifest.webmanifest" />',
      );
      expect(await findProjectIcon(root)).toBe(join(root, "src", "web", "icon-512.png"));
      const icon = await getProjectIcon(root);
      expect(icon?.mimeType).toBe("image/png");
      expect(icon?.data).toBe(data.toString("base64"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("ignores remote and data: hrefs", async () => {
    expect(extractHtmlIconHrefs('<link rel="icon" href="https://example.com/i.png" />')).toEqual([
      "https://example.com/i.png",
    ]);
    const root = await makeRoot();
    try {
      await writeFile(
        join(root, "index.html"),
        '<link rel="icon" href="https://example.com/i.png" /><link rel="icon" href="data:image/png;base64,AAAA" />',
      );
      expect(await findProjectIcon(root)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("parses link tags regardless of attribute order", async () => {
    expect(extractHtmlIconHrefs('<link href="./a.png" rel="apple-touch-icon" />')).toEqual(["./a.png"]);
    expect(extractHtmlManifestHref('<link href="./m.json" rel="manifest" />')).toBe("./m.json");
    expect(extractManifestIconSrcs(JSON.stringify({ icons: [{ src: "/i.png" }] }))).toEqual(["/i.png"]);
    expect(extractManifestIconSrcs("not json")).toEqual([]);
  });
});
