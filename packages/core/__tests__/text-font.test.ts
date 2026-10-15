import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalCore } from "../src";

const dir = mkdtempSync(join(tmpdir(), "beacon-text-font-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function frame(font: string): Promise<Buffer> {
  const core = new LocalCore({ cacheDir: join(dir, "cache") });
  const h = await core.create({ path: join(dir, `${font}.beproj`) });
  const text = { text: "Beacon", font, weight: 500, italic: false, size: 96, color: [1, 1, 1, 1], tracking: 0, lineSpacing: 0, align: "center", valign: "center" };
  await core.run(h, "edit.addAnnotation", { type: "callout", time: 0, duration: 1, props: { callout: { shape: "text", width: 900, height: 200, cornerRadius: 8, text } } });
  const out = join(dir, `${font}/`);
  await (await core.export(h, { output: out, from: 0, to: 1 / 30 })).done;
  await core.close(h);
  return readFileSync(join(out, readdirSync(out)[0]!));
}

test("text in a font this Mac doesn't have exports in Helvetica Neue instead of failing", async () => {
  expect((await frame("No Such Font Beacon")).equals(await frame("Helvetica Neue"))).toBe(true);
}, 60_000);
