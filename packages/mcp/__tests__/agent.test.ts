import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const RECORDING = join(homedir(), "client-videos/firecrawl/alexandria/alexandria.cmproj/recordings/1790097529.719643/demo_3.trec");
const dir = mkdtempSync(join(tmpdir(), "beacon-agent-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test.skipIf(!existsSync(RECORDING))(
  "an agent cuts a recording by its transcript, zooms, sees frames and undoes, only through MCP",
  async () => {
    const client = new Client({ name: "agent-test", version: "0" });
    await client.connect(new StdioClientTransport({ command: "bun", args: [join(import.meta.dir, "../src/main.ts")], stderr: "ignore" }));
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text?: string; data?: string }[] };
      if (r.isError) throw new Error(`${name}: ${r.content[0]?.text}`);
      return r.content;
    };
    const json = async (name: string, args: Record<string, unknown> = {}) => JSON.parse((await call(name, args))[0]!.text!);
    try {
      await call("project_create", { path: join(dir, "test.beproj") });
      const imported = await json("media_import", { files: [RECORDING] });
      for (const job of imported.jobs) {
        let state = "running";
        while (state === "running") state = (await json("job_status", { id: job, wait: 30 })).state;
        expect(state).toBe("done");
      }

      const words: { i: number; text: string; start: number; end: number }[] = await json("transcript_get", { format: "words" });
      expect(words.length).toBeGreaterThan(100);
      const before = (await call("project_describe"))[0]!.text!;
      const lengthBefore = words.at(-1)!.start;

      await json("transcript_cut", { words: [[0, 7]] });
      const after: typeof words = await json("transcript_get", { format: "words" });
      expect(after.length).toBe(words.length - 8);
      expect(after[0]!.text).toBe(words[8]!.text);
      // From the first cut word to 0.1 s before the next kept one (or the last cut word's end), rounded out to frames.
      const removed = Math.max(words[7]!.end, words[8]!.start - 0.1) - words[0]!.start;
      expect(Math.abs(lengthBefore - after.at(-1)!.start - removed)).toBeLessThanOrEqual(2 / 30 + 0.001);

      const screen = imported.clips[0];
      await json("zoom_to", { clip: screen, at: 2, rect: { x: 0, y: 0, width: 1800, height: 1013 }, until: 4 });
      const frame = await call("frame_at", { time: 3, width: 480 });
      expect(frame[0]!.type).toBe("image");
      expect(Buffer.from(frame[0]!.data!, "base64").subarray(1, 4).toString()).toBe("PNG");

      await call("project_undo");
      await call("project_undo");
      expect((await call("project_describe"))[0]!.text).toBe(before);
    } finally {
      await client.close();
    }
  },
  600_000,
);
