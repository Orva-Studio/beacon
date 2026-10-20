/**
 * Stands in for `beacon-recorder serve` (no microphone): a take is a microphone file the test made, and its
 * `recording.json` gets the host-clock start the test writes to `$FAKE_RECORDER_HOST_START` before it stops.
 * With `$FAKE_RECORDER_TAKE`, a take is a copy of that `.brec`, as its recorder left it.
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const reply = (e: object) => process.stdout.write(`${JSON.stringify(e)}\n`);
let dir: string | undefined;
reply({ event: "ready" });
for await (const line of console) {
  if (!line.trim()) continue;
  const { cmd, id, ...rest } = JSON.parse(line) as { cmd: string; id: number; dir?: string };
  const take = process.env.FAKE_RECORDER_TAKE;
  if (cmd === "start" && take) {
    dir = rest.dir!;
    cpSync(take, dir, { recursive: true });
    reply({ event: "recording", id, dir });
  } else if (cmd === "stop" && dir && take) {
    const { duration, errors } = JSON.parse(readFileSync(join(dir, "recording.json"), "utf8"));
    reply({ event: "stopped", id, take: { dir, duration, errors } });
    dir = undefined;
  } else if (cmd === "start") {
    dir = rest.dir!;
    mkdirSync(dir, { recursive: true });
    copyFileSync(process.env.FAKE_RECORDER_MIC!, join(dir, "microphone.wav"));
    reply({ event: "recording", id, dir });
  } else if (cmd === "stop" && dir) {
    const file = process.env.FAKE_RECORDER_HOST_START!;
    const hostStart = existsSync(file) ? Number(readFileSync(file, "utf8")) : 0;
    const microphone = { file: "microphone.wav", start: 0.02, rate: 48000, channels: 1 };
    writeFileSync(join(dir, "recording.json"), JSON.stringify({ version: 1, complete: true, hostStart, duration: 10, streams: { microphone }, errors: [] }));
    reply({ event: "stopped", id, take: { dir, duration: 10, errors: [] } });
    dir = undefined;
  } else if (cmd === "status") reply({ event: "status", id, recording: !!dir, ...(dir ? { dir, status: { elapsed: 1 } } : {}) });
  else reply({ event: "error", id, message: `the fake recorder doesn't ${cmd}` });
}
