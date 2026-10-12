#!/usr/bin/env bun
/**
 * Cuts a version, as hance does: on a clean, up-to-date main, sets the
 * version in every package.json (the app reads the root's), commits
 * `chore(release): vX`, tags `vX` and pushes both.
 *
 *   bun run release 0.2.0
 */
import { readFileSync, writeFileSync } from "node:fs";
import { $ } from "bun";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error("usage: bun run release <version>   (e.g. 0.2.0)");
  process.exit(1);
}
const tag = `v${version}`;

const branch = (await $`git rev-parse --abbrev-ref HEAD`.text()).trim();
if (branch !== "main") {
  console.error(`must be on main (currently on ${branch})`);
  process.exit(1);
}
const status = (await $`git status --porcelain`.text()).trim();
if (status) {
  console.error(`working tree not clean:\n${status}`);
  process.exit(1);
}
await $`git pull --ff-only`;
if ((await $`git tag --list ${tag}`.text()).trim()) {
  console.error(`tag ${tag} already exists`);
  process.exit(1);
}

const root = JSON.parse(readFileSync("package.json", "utf8"));
const files = ["package.json", ...(root.workspaces as string[]).map((ws) => `${ws}/package.json`)];
for (const file of files) {
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  pkg.version = version;
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
}

await $`git add ${files}`;
await $`git commit -m ${`chore(release): ${tag}`}`;
await $`git tag ${tag}`;
await $`git push origin main ${tag}`;
console.log(`\nreleased ${tag}`);
