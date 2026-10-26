/**
 * HyperFrames' registry (Apache 2.0, https://github.com/heygen-com/hyperframes) at a pinned commit, as the catalog
 * motion graphics' author learns from: each block's and component's name, description, HTML, and the license and
 * author it declares, written to `packages/features/src/motion/catalog.json`. Code only: images, sounds and fonts
 * aren't copied (each item lists the ones it uses), the CDN scripts are dropped (the page has GSAP and three.js
 * itself), and items over MAX_HTML are left out (most of those embed a large bundled library). Run to move to a newer
 * commit.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const COMMIT = "2d1b5cfbd2ffff65bdd342d78ce64a7dd36c4695";
const BASE = `https://raw.githubusercontent.com/heygen-com/hyperframes/${COMMIT}/registry`;
const MAX_HTML = 100_000;
const DIRS: Record<string, string> = { "hyperframes:block": "blocks", "hyperframes:component": "components" };

interface Item {
  name: string;
  type: string;
  title?: string;
  description?: string;
  tags?: string[];
  license?: string;
  author?: string;
  authorUrl?: string;
  duration?: number;
  dimensions?: { width: number; height: number };
  files?: ({ path: string } | string)[];
}

const get = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.text();
};

const manifest = JSON.parse(await get(`${BASE}/registry.json`)) as { items: { name: string; type: string }[] };
const wanted = manifest.items.filter((i) => DIRS[i.type]);
const out: object[] = [];
let skipped = 0;
for (let i = 0; i < wanted.length; i += 16) {
  const batch = await Promise.all(
    wanted.slice(i, i + 16).map(async ({ name, type }) => {
      const dir = `${BASE}/${DIRS[type]}/${name}`;
      const item = JSON.parse(await get(`${dir}/registry-item.json`)) as Item;
      const paths = (item.files ?? []).map((f) => (typeof f === "string" ? f : f.path));
      const code = paths.filter((p) => /\.(html|css|js)$/.test(p));
      const sources = await Promise.all(code.map(async (p) => `<!-- ${p} -->\n${await get(`${dir}/${p}`)}`));
      const html = sources.join("\n").replace(/<script\b[^>]*\bsrc="https?:\/\/[^"]*"[^>]*>\s*<\/script>\n?/g, "");
      if (html.length > MAX_HTML) return null;
      return {
        name,
        kind: DIRS[type] === "blocks" ? "block" : "component",
        title: item.title ?? name,
        description: item.description ?? "",
        tags: item.tags ?? [],
        ...(item.license ? { license: item.license } : {}),
        ...(item.author ? { author: item.author, ...(item.authorUrl ? { authorUrl: item.authorUrl } : {}) } : {}),
        ...(item.duration ? { duration: item.duration } : {}),
        ...(item.dimensions ? { size: [item.dimensions.width, item.dimensions.height] } : {}),
        missing: paths.filter((p) => !code.includes(p) && !/\.(md|txt)$/.test(p)),
        html,
      };
    }),
  );
  for (const b of batch) b ? out.push(b) : skipped++;
}
writeFileSync(join(import.meta.dir, "../packages/features/src/motion/catalog.json"), JSON.stringify({ source: `heygen-com/hyperframes@${COMMIT}`, license: "Apache-2.0", items: out }));
console.log(`${out.length} items in the catalog, ${skipped} over ${MAX_HTML} bytes left out`);
