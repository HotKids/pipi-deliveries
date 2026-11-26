import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

// G-LOW-13 (2026-11-20 review): bundled artwork goes through the shared loaders. The recognition provider logos use
// bundledImage (decoded once per path), and the pickup cards keep the last four animation atlases, so switching
// between a few cards does not read and decode an atlas again.
const settings = readFileSync(new URL("../pages/RecognitionSettingsPage.tsx", import.meta.url), "utf8");
assert.doesNotMatch(settings, /filePath=/, "no per-render file decode on the recognition page");
assert.match(settings, /const artwork = bundledImage\(`recognition\/\$\{image\}`\);\s*return artwork \? \(\s*<Image image=\{artwork\}/);

const card = readFileSync(new URL("../components/PickupTabCard.tsx", import.meta.url), "utf8");
const start = card.indexOf("const ATLAS_CACHE_SLOTS");
assert.ok(start >= 0, "the atlas cache has a fixed slot count");
const code = stripTypeScriptTypes(card.slice(start, card.indexOf("function stickerEase(", start)));
const reads: string[] = [];
const { loadArtworkAtlas, cachedArtworkAtlas } = Function("FileManager", "UIImage", "Script",
  `${code}\nreturn { loadArtworkAtlas, cachedArtworkAtlas };`)(
  { readAsData: async (path: string) => { reads.push(path.split("/").pop()!); return path; } },
  { fromData: (data: string) => ({ data }) },
  { directory: "/synthetic" },
);
const paths = ["a.png", "b.png", "c.png", "d.png"];
for (const path of paths) await loadArtworkAtlas(path);
for (const path of paths) await loadArtworkAtlas(path);
assert.deepEqual(reads, paths, "four atlases stay loaded");
assert.equal((cachedArtworkAtlas("a.png") as { data: string }).data, "/synthetic/assets/a.png");
await loadArtworkAtlas("e.png");
assert.equal(cachedArtworkAtlas("b.png"), undefined, "a fifth atlas drops the least recently used one");
assert.ok(cachedArtworkAtlas("a.png"), "a recent use keeps an atlas");
await loadArtworkAtlas("b.png");
assert.deepEqual(reads, [...paths, "e.png", "b.png"]);
console.log("bundled artwork loaders cache their decodes");
