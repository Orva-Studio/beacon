import { afterAll, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { LocalCore } from "../src";

const FIXTURES = process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures");
const AUDIO = join(FIXTURES, "audio.m4a");
const dir = mkdtempSync(join(tmpdir(), "beacon-transcriber-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Words = { text: string; start: number; end: number }[];

test.skipIf(!existsSync(AUDIO))(
  "the transcriber is a preference: Apple's needs no download, transcripts are kept per transcriber, and OpenAI's waits for its key",
  async () => {
    const secrets = new Map<string, string>();
    // A cache with no speech model in it, as on a Mac that never downloaded it.
    const core = new LocalCore({
      cacheDir: join(dir, "cache"),
      configDir: join(dir, "config"),
      secrets: { get: async (id) => secrets.get(id), set: async (id, v) => void (v === null ? secrets.delete(id) : secrets.set(id, v)) },
    });
    const h = await core.create({ path: join(dir, "t.beproj") });
    const audio = join(dir, "voice.m4a");
    copyFileSync(AUDIO, audio);
    const transcriber = async () => (await core.preferences()).find((p) => p.id === "transcriber")!;
    expect((await transcriber()).value).toBe("whisper");

    await core.setPreference("transcriber", "apple");
    const imported = await core.import(h, [audio], { at: 0 });
    expect(imported.needs).toBeUndefined();
    const job = (await core.jobs()).find((j) => j.kind === "transcript" && imported.jobs.includes(j.id));
    expect(job).toBeDefined();
    while ((await core.job(job!.id)).state === "running") await Bun.sleep(200);
    expect((await core.job(job!.id)).state).toBe("done");
    const apple = (await core.query(h, "transcript.get", { format: "words" })) as Words;
    expect(apple.length).toBeGreaterThan(800);
    expect(readdirSync(join(dir, "cache", "derived")).some((f) => /^transcript-v\d+-apple-[0-9a-f]{16}\.json$/.test(f))).toBe(true);

    // Back to Whisper, whose model isn't here: no transcript, and the download is asked for, as on import.
    const events: string[] = [];
    const stop = core.watch(h, (e) => e.kind === "needs" && events.push(e.resource.id));
    await core.setPreference("transcriber", "whisper");
    expect(events).toEqual(["whisper-model"]);
    expect((await core.query(h, "transcript.get", { format: "words" })) as Words).toEqual([]);
    // Apple's transcript is still there for when it is chosen again.
    await core.setPreference("transcriber", "apple");
    expect((await core.query(h, "transcript.get", { format: "words" })) as Words).toEqual(apple);
    expect((await core.jobs()).filter((j) => j.kind === "transcript").length).toBe(1);
    stop();

    // OpenAI's needs the user's key; only the app sets it.
    await expect(core.setPreference("transcriber", "openai")).rejects.toThrow(/only the user can add/);
    expect((await transcriber()).options.find((o) => o.id === "openai")!.secret).toEqual({ id: "openai-api-key", title: "OpenAI API key", set: false });
    await core.setSecret("openai-api-key", "sk-test");
    expect((await transcriber()).options.find((o) => o.id === "openai")!.secret!.set).toBe(true);
    core.setAutomatic((a) => a !== "transcript");
    await core.setPreference("transcriber", "openai");
    // Without it again, the choice goes back to the default.
    await core.setSecret("openai-api-key", null);
    expect((await transcriber()).value).toBe("whisper");
    // Kept across launches.
    await core.setPreference("transcriber", "apple");
    await core.close(h);
    expect((await (new LocalCore({ configDir: join(dir, "config") })).preferences())[0]!.value).toBe("apple");
  },
  120_000,
);
