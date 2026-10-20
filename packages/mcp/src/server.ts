import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { formatIssues, fpsRational, jsonSchemaOf, KeysSchema, SETTINGS_TABS, SettingsPatchSchema, UI_DIALOGS, VideoEncodingSchema, type CommandInfo, type CommandResult, type Image, type BeaconCore, type ProjectHandle } from "@beacon/core";
import { DOCS, INSTRUCTIONS, WORKFLOWS, type Workflow } from "./docs";

type Content = CallToolResult["content"];

interface ToolDef {
  description: string;
  schema: z.ZodType;
  run: (args: any) => Promise<Content | unknown>;
}

/** Claude's API allows only `[a-zA-Z0-9_-]` in tool names. */
const toolName = (id: string) => id.replaceAll(".", "_");

const text = (t: string): Content => [{ type: "text", text: t }];

function image(img: Image, caption: string): Content {
  return [
    { type: "image", data: Buffer.from(img.png).toString("base64"), mimeType: "image/png" },
    { type: "text", text: caption },
  ];
}

const MAX_DIFF = 40;

function commandReply(r: CommandResult): string {
  const diff = r.diff.length > MAX_DIFF ? [...r.diff.slice(0, MAX_DIFF), `... ${r.diff.length - MAX_DIFF} more changes`] : r.diff;
  const result = r.results.length === 1 ? r.results[0] : r.results;
  return JSON.stringify(
    {
      ...(result === undefined ? {} : { result }),
      [r.dryRun ? "wouldChange" : "changed"]: diff.length ? diff : "nothing",
      ...(r.dryRun ? { dryRun: true } : { undo: r.label }),
    },
    null,
    1,
  );
}

const Seconds = z.number().nonnegative();
const RunFlags = { dryRun: z.boolean().optional().describe("Return the change without applying it"), label: z.string().optional().describe("Undo history label") };

export interface ServerOptions {
  /** The open app's core for a project it holds, so edits go live; local otherwise. */
  appCore?: (project: string) => Promise<BeaconCore | undefined>;
  /** The projects open in running Beacon apps (`project_open` without a path). */
  appProjects?: () => Promise<string[]>;
}

/**
 * The `beacon-mcp` server (PLAN §7): every registered command and query
 * becomes a tool, beside project, media, frame, export and job tools.
 */
export function createServer(local: BeaconCore, version: string, opts: ServerOptions = {}): Server {
  /** The core holding the session's project: local, or the open app's. */
  let core = local;
  let current: ProjectHandle | undefined;
  const project = () => {
    if (!current) throw new Error("no project open: call project_open (with no path, it connects to the project open in the Beacon app) or project_create first");
    return current;
  };

  // The new project is open before the old one closes, so a failed open leaves the session as it was.
  const switchTo = async (h: ProjectHandle, next: BeaconCore) => {
    if (current && (current !== h || next !== core)) {
      // A closed app can't detach us; that must not block opening something else.
      await core.close(current).catch((e: unknown) => {
        if (core === local) throw e;
      });
    }
    // Each project_open on an app project connects anew; the old connection is done with.
    if (core !== local && core !== next) (core as { disconnect?: () => void }).disconnect?.();
    current = h;
    core = next;
  };
  const save = async (path: string, data: Uint8Array, overwrite: boolean) => {
    const p = expandHome(path);
    await core.checkOutput(project(), p, { overwrite });
    mkdirSync(dirname(p), { recursive: true });
    await Bun.write(p, data);
    return p;
  };
  const Save = {
    save: z.string().optional().describe("Also write the PNG to this path"),
    overwrite: z.boolean().default(false).describe("Replace an existing file at `save`"),
  };

  const commands = local.commands();
  const commandIds = new Set(commands.map((c) => c.id));
  const commandOfTool = new Map(commands.map((c) => [toolName(c.id), c.id]));
  const tools = new Map<string, ToolDef>();
  const add = (name: string, def: ToolDef) => tools.set(name, def);

  add("project_create", {
    description: "Create a new Beacon project (a .beproj folder) and make it the session's project. Optionally start from a Camtasia .cmproj (read only)",
    schema: z.strictObject({
      path: z.string().describe("New folder ending in .beproj"),
      cmproj: z.string().optional(),
      width: z.int().positive().optional(),
      height: z.int().positive().optional(),
      fps: z.int().positive().optional(),
      standalone: z.boolean().optional().describe("Copy media into the project's media folder as it is imported (a .cmproj's media too), so the project can be moved or shared whole"),
    }),
    async run({ path, cmproj, width, height, fps, standalone }) {
      const settings = { ...(width ? { width } : {}), ...(height ? { height } : {}), ...(fps ? { fps: fpsRational(fps) } : {}) };
      const h = await local.create({ path: expandHome(path), cmproj: cmproj && expandHome(cmproj), settings, ...(standalone ? { standalone } : {}) });
      await switchTo(h, local);
      return text(`created ${h}\n\n${await core.summary(h)}`);
    },
  });
  const appProject = async () => {
    const open = (await opts.appProjects?.()) ?? [];
    if (open.length === 1) return open[0]!;
    if (!open.length) throw new Error("the Beacon app isn't running or has no project open: give project_open a path");
    throw new Error(`Beacon apps have ${open.length} projects open; give project_open one of their paths: ${open.join(", ")}`);
  };
  add("project_open", {
    description:
      "Open an existing .beproj project as the session's project. If the Beacon app has it open, the session connects to the app: edits appear on its timeline live and share its undo history. Without `path`, the project open in the Beacon app",
    schema: z.strictObject({ path: z.string().optional().describe("A .beproj folder; omitted: the one open in the Beacon app") }),
    async run({ path }) {
      const p = path ? expandHome(path) : await appProject();
      const app = await opts.appCore?.(p);
      const next = app ?? local;
      const h = await next.open(p);
      await switchTo(h, next);
      return text(`${app ? "connected to the open Beacon app; changes show there live\n\n" : ""}${await core.summary(h)}`);
    },
  });
  add("project_save", {
    description: "Save the project now (changes are also saved after every command)",
    schema: z.strictObject({}),
    run: async () => (await core.save(project()), text("saved")),
  });
  add("project_saveAs", {
    description:
      "Save As: copy the project as it is now to a new .beproj folder, with its recordings and the media kept inside it, and make the copy the session's project (opened by this session; an app showing the original keeps showing it). `standalone` (default: as the project is) also copies media from elsewhere into the copy's media folder, so it can be moved or shared whole",
    schema: z.strictObject({ path: z.string().describe("New folder ending in .beproj"), standalone: z.boolean().optional() }),
    async run({ path, standalone }) {
      const to = await core.saveAs(project(), expandHome(path), standalone === undefined ? {} : { standalone });
      // Opened here, not in the app: its window stays on the original, which the user is looking at.
      const h = await local.open(to);
      await switchTo(h, local);
      return text(`saved as ${h}\n\n${await core.summary(h)}`);
    },
  });
  add("project_reveal", {
    description: "Show the project's folder in Finder (on the user's screen)",
    schema: z.strictObject({}),
    run: async () => (await core.reveal(project()), text("shown in Finder")),
  });
  add("project_undo", {
    description: "Undo the last change (a command or transaction)",
    schema: z.strictObject({}),
    run: async () => {
      const label = await core.undo(project());
      return text(label ? `undid "${label}"` : "nothing to undo");
    },
  });
  add("project_redo", {
    description: "Redo the last undone change",
    schema: z.strictObject({}),
    run: async () => {
      const label = await core.redo(project());
      return text(label ? `redid "${label}"` : "nothing to redo");
    },
  });
  add("project_history", {
    description: "Undo and redo history labels, oldest first",
    schema: z.strictObject({}),
    run: async () => core.history(project()),
  });
  add("media_import", {
    description:
      "Import media files (.trec recordings, video, images, audio) onto the timeline, at the end or at `at` seconds; with `track`, onto that track as a drop does (the rest of a recording on the tracks above; refused over other media). A .trec becomes linked Screen, Camera and Audio clips. Starts background transcript jobs for speech; see job_status",
    schema: z.strictObject({ files: z.array(z.string()).min(1), at: Seconds.optional(), track: z.string().min(1).optional() }),
    run: async ({ files, at, track }) => core.import(project(), files.map(expandHome), { at, ...(track ? { track } : {}) }),
  });
  add("media_missing", {
    description: "Media whose file is no longer where the project says (moved, renamed or deleted): their asset ids",
    schema: z.strictObject({}),
    run: async () => core.missing(project()),
  });
  add("media_relink", {
    description: "Point missing media at its file's new place; refused unless it is the same media (kind, streams, length). One undo step",
    schema: z.strictObject({ asset: z.string(), path: z.string() }),
    run: async ({ asset, path }) => core.relink(project(), asset, expandHome(path)),
  });
  add("media_replace", {
    description:
      "Replace an imported video, image or audio file with another of the same kind; its clips keep their places and settings, shortened where the new file ends sooner. Not for recordings. One undo step; returns the new file's analysis jobs",
    schema: z.strictObject({ asset: z.string(), path: z.string() }),
    run: async ({ asset, path }) => core.replace(project(), asset, expandHome(path)),
  });
  const device = z.strictObject({ id: z.string().optional().describe("A device id from recorder_devices; omitted: the default device") });
  add("recorder_devices", {
    description: "What can be recorded: the Screen Recording, Camera and Microphone permissions, and the displays, cameras and microphones with their ids",
    schema: z.strictObject({}),
    run: async () => core.recorderDevices(),
  });
  add("recorder_access", {
    description: "Ask macOS for the camera or microphone permission (it shows its prompt the first time, to the user); returns the status after",
    schema: z.strictObject({ kind: z.enum(["camera", "microphone"]) }),
    run: async ({ kind }) => core.recorderAccess(kind),
  });
  add("recorder_start", {
    description:
      "Start recording a take (a .brec folder in the project's recordings): the screen without its cursor (Beacon draws its own), the system audio, a camera and a microphone, each optional. Default: the main display, the default microphone and the system audio. Returns once every source is delivering; recorder_stop ends it and imports it. " +
      "`narrate`: voice narration, with only a `microphone`: the app plays the timeline from the playhead (or through the in/out range) while it records, silently unless `hear`; it ends at recorder_stop, the end of the range or a pause (with nothing after the playhead, nothing plays and it records there until recorder_stop), and goes on a new Narration track where it began, lined up with what played, transcribed like an import (recorder_status's `last` says what an ending by itself imported). Needs the project open in the app",
    schema: z.strictObject({
      screen: z.strictObject({ display: z.int().optional().describe("A display id; omitted: the main display"), fps: z.int().min(1).max(60).optional() }).optional(),
      systemAudio: z.boolean().optional(),
      camera: device.optional(),
      microphone: device.optional(),
      name: z.string().min(1).optional().describe("The take's name; omitted: the date and time"),
      narrate: z.boolean().optional().describe("Voice narration over the timeline: record only the microphone while the app plays it"),
      hear: z.boolean().optional().describe("With `narrate`: play the timeline's sound too (only with headphones, or it bleeds into the take)"),
    }),
    run: async ({ name, narrate, hear, ...sources }) =>
      core.recordStart(project(), { ...(Object.keys(sources).length ? { sources } : {}), ...(name ? { name } : {}), ...(narrate ? { narrate: { hear: !!hear } } : {}) }),
  });
  add("recorder_status", {
    description: "Whether a take is being recorded, its folder and the seconds recorded",
    schema: z.strictObject({}),
    run: async () => core.recordStatus(),
  });
  add("recorder_stop", {
    description:
      "Stop the take and import it into the project it was started for: linked Screen, Camera and audio clips at the end of the timeline (or at `at`), the cursor drawn from its log; a narration on its own track where it began. `discard`: throw the take away instead. One undo step",
    schema: z.strictObject({ at: Seconds.optional(), discard: z.boolean().optional() }),
    run: async ({ at, discard }) => core.recordStop({ ...(at === undefined ? {} : { at }), ...(discard ? { discard } : {}) }),
  });
  add("transaction", {
    description:
      "Run several commands as one undo step, all or nothing: `commands` is a list of {command, args} with command ids as in commands (dotted, e.g. \"zoom.to\") or tool names. Results come back in order",
    schema: z.strictObject({
      label: z.string(),
      commands: z.array(z.strictObject({ command: z.string(), args: z.record(z.string(), z.unknown()).default({}) })).min(1),
      dryRun: z.boolean().optional(),
    }),
    async run({ label, commands, dryRun }) {
      const steps = (commands as { command: string; args: unknown }[]).map((c) => ({ command: commandOfTool.get(c.command) ?? c.command, args: c.args }));
      const r = await core.transaction(project(), label, steps, { dryRun });
      return text(commandReply(r));
    },
  });
  add("frame_at", {
    description: "Render the canvas at a timeline time, as the export will look. Returns the image",
    schema: z.strictObject({
      time: Seconds,
      width: z.int().positive().max(3840).default(960).describe("Pixels; above the canvas width the frame is upscaled"),
      ...Save,
    }),
    async run({ time, width, save: to, overwrite }) {
      const img = await core.frame(project(), time, { width });
      const saved = to && (await save(to, img.png, overwrite));
      return image(img, `frame at ${time}s (${img.width}x${img.height})${saved ? `, saved to ${saved}` : ""}`);
    },
  });
  add("frame_capture", {
    description: "Snapshot: save the canvas at a timeline time (default: the playhead) as a PNG in the project's media folder (or `folder`) and add it to the Media Bin. Returns the asset id",
    schema: z.strictObject({ time: Seconds.optional(), folder: z.string().optional().describe("An existing folder to save it in instead (~ allowed)") }),
    async run({ time, folder }) {
      const r = await core.captureFrame(project(), time, folder ? { folder: expandHome(folder) } : {});
      return text(`added ${r.asset} (${r.path}) to the Media Bin`);
    },
  });
  add("frames_sheet", {
    description: "Render a contact sheet: `count` frames evenly spaced from `from` to `to` (timeline seconds), left to right, top to bottom",
    schema: z.strictObject({
      from: Seconds,
      to: Seconds,
      count: z.int().min(1).max(48).default(12),
      columns: z.int().min(1).max(8).optional(),
      width: z.int().min(64).max(960).default(320).describe("Width of each frame"),
      ...Save,
    }),
    async run({ from, to, count, columns, width, save: path, overwrite }) {
      const img = await core.sheet(project(), { from, to, count, columns, width });
      const saved = path && (await save(path, img.png, overwrite));
      return image(img, `frames at ${img.times.join(", ")}s${saved ? `; saved to ${saved}` : ""}`);
    },
  });
  add("export_start", {
    description:
      "Export the project (or `from`-`to` seconds) in the background to a .mp4, .mov, .gif or .webm path (the format), a .wav, .m4a or .mp3 path for the audio alone (no frames rendered), or a folder ending in / for PNG frames. Returns a job id for job_status; job_cancel stops it",
    schema: VideoEncodingSchema.extend({
      output: z.string(),
      from: Seconds.optional(),
      to: Seconds.optional(),
      overwrite: z.boolean().default(false).describe("Replace an existing file"),
    }),
    async run({ output, ...rest }) {
      const job = await core.export(project(), { output: expandHome(output), ...rest });
      return core.job(job.id);
    },
  });
  add("analyze", {
    description: "Run a background analyzer for an asset again or for the first time, e.g. key \"transcript\". Returns a job id",
    schema: z.strictObject({ key: z.string(), asset: z.string() }),
    run: async ({ key, asset }) => core.job((await core.analyze(project(), key, asset)).id),
  });
  add("analysis_delete", {
    description: "Delete an asset's background analysis and the files it made, e.g. key \"proxy\" to free a proxy's disk space (the app builds preview analyses again when it next shows the project). Returns whether there was one",
    schema: z.strictObject({ key: z.string(), asset: z.string() }),
    run: async ({ key, asset }) => core.forget(project(), key, asset),
  });
  add("analysis_size", {
    description: "Bytes on disk of a background analyzer's results across every project, e.g. key \"proxy\" for the space all proxy videos use",
    schema: z.strictObject({ key: z.string() }),
    run: async ({ key }) => core.analysisSize(key),
  });
  add("analysis_delete_all", {
    description: "Delete a background analyzer's results for every asset of every project, e.g. key \"proxy\" (the app builds preview analyses again when it next shows a project). Returns the bytes freed",
    schema: z.strictObject({ key: z.string() }),
    run: async ({ key }) => core.forgetAll(key),
  });
  add("job_cancel", {
    description: "Stop a running job (an export, an analysis); it ends as failed with \"cancelled\"",
    schema: z.strictObject({ id: z.string() }),
    run: async ({ id }) => (await core.cancelJob(id), core.job(id)),
  });
  add("resource_list", {
    description: "Files analyses need that don't ship with Beacon (Whisper's speech model, for transcripts): what each is for, its size, and whether it is downloaded",
    schema: z.strictObject({}),
    run: async () => core.resources(),
  });
  add("resource_fetch", {
    description:
      "Download a resource from resource_list as a background job (job_status). It can be large (the speech model is about 575 MB): ask the user first. Analyses that waited for it (transcripts) start when it is done",
    schema: z.strictObject({ id: z.string() }),
    run: async ({ id }) => ({ job: (await core.fetchResource(id)).id }),
  });
  add("preference_list", {
    description:
      "App-wide choices, kept across projects: the transcriber (Whisper on this Mac, needing its speech model; Apple's on-device transcriber, no download; or Whisper through OpenAI's API, which uploads the audio and needs the user's API key). Each option says what it means and whether a key it needs is set",
    schema: z.strictObject({}),
    run: async () => core.preferences(),
  });
  add("preference_set", {
    description:
      "Change an app-wide choice, e.g. id \"transcriber\", value \"apple\". Transcripts are kept per transcriber: media without one by the new choice is transcribed again (job_status), or waits for Whisper's model as an import does. An option needing an API key is refused until the user adds it in Settings. Choosing OpenAI uploads the user's audio to OpenAI and costs them: only when they ask",
    schema: z.strictObject({ id: z.string(), value: z.string() }),
    run: async ({ id, value }) => (await core.setPreference(id, value), core.preferences()),
  });
  add("favorites_list", {
    description:
      "The Favorites panel's items, in order (app-wide, the user's): annotation:<preset> (text, rectangle, spotlight, blur, pixelate), effect:<id> (as effect_add takes) or audio:fade-in / audio:fade-out",
    schema: z.strictObject({}),
    run: async () => core.favorites(),
  });
  add("favorites_add", {
    description: "Star an item: add it to the Favorites panel (at `index`, else at the end). Only when the user asks: the list is theirs",
    schema: z.strictObject({ item: z.string(), index: z.int().nonnegative().optional() }),
    run: async ({ item, index }) => core.favoriteAdd(item, index),
  });
  add("favorites_remove", {
    description: "Un-star an item: remove it from the Favorites panel",
    schema: z.strictObject({ item: z.string() }),
    run: async ({ item }) => core.favoriteRemove(item),
  });
  add("favorites_move", {
    description: "Move a favourite to `index` in the Favorites panel (0 first)",
    schema: z.strictObject({ item: z.string(), index: z.int().nonnegative() }),
    run: async ({ item, index }) => core.favoriteMove(item, index),
  });
  add("settings_get", {
    description:
      "The app's settings (the user's, app-wide; Settings › General and Recording): exportColorSpace (bt709 or srgb, what export_start uses unless told), autoProxy (which media get proxies made on their own: recording, video), proxyMode (quiet: one at a time at background priority; fast: two at once), snapshotFolder (where frame_capture saves; unset, the project's media folder), cameraSync (each camera and microphone's measured delay)",
    schema: z.strictObject({}),
    run: async () => core.settings(),
  });
  add("settings_set", {
    description: "Change some of the app's settings (see settings_get); the rest keep theirs. snapshotFolder must exist; null goes back to the project's media folder. Only when the user asks: the settings are theirs",
    // Camera delays come from Check Sync and declined downloads from the user: not an agent's to set.
    schema: SettingsPatchSchema.pick({ exportColorSpace: true, autoProxy: true, proxyMode: true, snapshotFolder: true }).strict(),
    run: async (patch) => core.setSettings(Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))),
  });
  add("ui_open", {
    description:
      "Show a dialog in the app's window as its menus do, to see it with ui_snapshot: settings (on `tab`: general, recording, transcripts or shortcuts), projectSettings (the project's canvas, frame rate, background, loudness), export, exportSelection, newProject or record; null closes the open one. Only with the project open in the app. It changes nothing by itself: settings_set, export_start and the like do",
    schema: z.strictObject({ dialog: z.enum(UI_DIALOGS).nullable(), tab: z.enum(SETTINGS_TABS).optional() }),
    run: async ({ dialog, tab }) => (await core.uiOpen(project(), dialog, tab), dialog ? `${dialog} is open` : "closed"),
  });
  add("shortcuts_list", {
    description:
      "Every action of the editor's menus, keys and command palette, with its keyboard shortcuts (the user's, app-wide): id, name, description, the command it runs and its keys. `standard`: still the default keys",
    schema: z.strictObject({}),
    run: async () => core.shortcuts(),
  });
  add("shortcuts_set", {
    description:
      "Give an action (its id from shortcuts_list) these keys, replacing its own; [] removes its shortcut. A key another action has is refused, naming it, unless `replace` moves it here. Only when the user asks: the keys are theirs",
    schema: z.strictObject({ action: z.string(), keys: z.array(KeysSchema), replace: z.boolean().default(false) }),
    run: async ({ action, keys, replace }) => (await core.shortcutSet(action, keys, replace)).filter((s) => s.id === action || !s.standard),
  });
  add("shortcuts_reset", {
    description: "Put an action's shortcut back to the default, or every action's (no `action`)",
    schema: z.strictObject({ action: z.string().optional() }),
    run: async ({ action }) => (await core.shortcutReset(action)).filter((s) => !s.standard),
  });
  add("job_status", {
    description: "Status of a background job (export, transcript, download), or of all jobs. With `wait`, blocks up to that many seconds for the job to finish",
    schema: z.strictObject({ id: z.string().optional(), wait: z.number().min(0).max(55).default(0) }),
    async run({ id, wait }) {
      if (!id) return core.jobs();
      if (wait > 0) {
        // Watched before asking, so an end in between isn't missed.
        let stop = () => {};
        const ended = new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, wait * 1000);
          const unwatch = core.watchApp((e) => e.kind === "job" && e.job.id === id && e.job.state !== "running" && resolve());
          stop = () => (clearTimeout(timer), unwatch());
        });
        if ((await core.job(id)).state === "running") await ended;
        stop();
      }
      return core.job(id);
    },
  });

  add("ui_snapshot", {
    description:
      "What the editor shows: a screenshot of the app window (when the app has the project open) plus the playhead, selection, in/out range, visible timeline span and open panels",
    schema: z.strictObject({}),
    async run() {
      const snap = await core.snapshot(project());
      return snap.image ? image(snap.image, snap.description) : text(snap.description);
    },
  });

  const commandSchemas = new Map<string, CommandInfo>();
  for (const c of commands) {
    const own = Object.keys((c.args.properties as object | undefined) ?? {}).filter((k) => k in RunFlags);
    if (own.length) throw new Error(`command ${c.id} has its own ${own.join("/")} argument, which clashes with the run flags every command tool takes`);
    commandSchemas.set(toolName(c.id), c);
    add(toolName(c.id), {
      description: c.description,
      schema: z.unknown(),
      async run(args: Record<string, unknown>) {
        const { dryRun, label, ...rest } = args ?? {};
        return text(commandReply(await core.run(project(), c.id, rest, { dryRun: dryRun === true, label: typeof label === "string" ? label : undefined })));
      },
    });
  }
  for (const q of local.queries()) {
    commandSchemas.set(toolName(q.id), q);
    add(toolName(q.id), { description: q.description, schema: z.unknown(), run: (args) => core.query(project(), q.id, args ?? {}) });
  }

  const server = new Server({ name: "beacon", version }, { capabilities: { tools: {}, resources: {}, prompts: {} }, instructions: INSTRUCTIONS });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...tools].map(([name, def]): Tool => {
      const info = commandSchemas.get(name);
      if (info) {
        const isCommand = commandIds.has(info.id);
        const schema = info.args as Tool["inputSchema"];
        const inputSchema = isCommand ? { ...schema, properties: { ...(schema.properties ?? {}), ...jsonProps(RunFlags) } } : schema;
        return { name, description: `${info.description}${isCommand ? ` (command ${info.id})` : ""}`, inputSchema: { ...inputSchema, type: "object" } };
      }
      return { name, description: def.description, inputSchema: inputJson(def.schema) };
    }),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const def = tools.get(req.params.name);
    if (!def) return { isError: true, content: text(`unknown tool ${req.params.name}`) };
    try {
      const args = def.schema instanceof z.ZodUnknown ? (req.params.arguments ?? {}) : def.schema.parse(req.params.arguments ?? {});
      const out = await def.run(args);
      const content = Array.isArray(out) && out.every((c) => c && typeof c === "object" && "type" in c) ? (out as Content) : text(typeof out === "string" ? out : JSON.stringify(out, null, 1));
      return { content };
    } catch (e) {
      const message = e instanceof z.ZodError ? formatIssues(e) : e instanceof Error ? e.message : String(e);
      return { isError: true, content: text(message) };
    }
  });

  const resources = [
    ...local.queries().flatMap((q) =>
      q.resource
        ? [{ ...q.resource, read: async () => ((v: unknown) => (typeof v === "string" ? v : JSON.stringify(v, null, 1)))(await core.query(project(), q.id)) }]
        : [],
    ),
    { uri: "beacon://reference/commands", name: "Command and query reference", mimeType: "text/markdown", read: async () => reference(local) },
    ...Object.entries(DOCS).map(([name, body]) => ({ uri: `beacon://docs/${name}`, name: `Reference: ${name}`, mimeType: "text/markdown", read: async () => body })),
    ...Object.entries(WORKFLOWS).map(([name, w]) => ({ uri: `beacon://workflows/${name}`, name: `Workflow: ${w.description}`, mimeType: "text/markdown", read: async () => w.body })),
  ];
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: resources.map(({ read: _, ...r }) => r) }));
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const r = resources.find((x) => x.uri === req.params.uri);
    if (!r) throw new Error(`unknown resource ${req.params.uri}`);
    return { contents: [{ uri: r.uri, mimeType: r.mimeType, text: String(await r.read()) }] };
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: Object.entries(WORKFLOWS).map(([name, w]) => ({
      name,
      description: w.description,
      arguments: Object.entries(w.args).map(([arg, description]) => ({ name: arg, description, required: false })),
    })),
  }));
  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const w: Workflow | undefined = WORKFLOWS[req.params.name];
    if (!w) throw new Error(`unknown prompt ${req.params.name}`);
    const body = w.body.replace(/\{\{(\w+)\}\}/g, (_, k: string) => req.params.arguments?.[k] ?? `<${k}>`);
    return { description: w.description, messages: [{ role: "user", content: { type: "text", text: body } }] };
  });

  return server;
}

function expandHome(p: string): string {
  return resolve(p.startsWith("~/") ? `${homedir()}${p.slice(1)}` : p) + (p.endsWith("/") ? "/" : "");
}

function inputJson(schema: z.ZodType): Tool["inputSchema"] {
  return { ...jsonSchemaOf(schema), type: "object" } as Tool["inputSchema"];
}

function jsonProps(shape: Record<string, z.ZodType>): Record<string, object> {
  return (inputJson(z.object(shape)) as { properties: Record<string, object> }).properties;
}

/** Markdown reference generated from the registry, so new features document themselves. */
function reference(core: BeaconCore): string {
  const section = (title: string, items: CommandInfo[]) => [
    `## ${title}`,
    ...items.map((c) => `### ${toolName(c.id)} (\`${c.id}\`, feature ${c.feature})\n${c.description}\n\n\`\`\`json\n${JSON.stringify(c.args)}\n\`\`\``),
  ];
  const schema = core.schema();
  const json = (v: unknown) => `\`\`\`json\n${JSON.stringify(v)}\n\`\`\``;
  return [
    "# Beacon commands and queries",
    "Every command tool also takes `dryRun` and `label`.",
    ...section("Commands", core.commands()),
    ...section("Queries", core.queries()),
    "## Clip types\nWhich prop groups (`clip_set` props) and effects (`effect_add` type) each clip type takes.",
    ...schema.clipTypes.map((t) => `- \`${t.id}\`: ${t.description}. Props: ${t.props.map((p) => `\`${p}\``).join(", ") || "none"}. Effects: ${t.effects.map((e) => `\`${e}\``).join(", ") || "none"}`),
    "## Prop groups\nSet with `clip_set` (`{props: {<group>: {<field>: value}}}`); animatable fields are targets for `animation_add` as `\"<group>.<field>\"`.",
    ...schema.props.map((g) => `### \`${g.id}\`\n${g.description}.${g.animatable.length ? ` Animatable: ${g.animatable.join(", ")}.` : ""}\n\n${json(g.schema)}`),
    "## Effects\nAdd with `effect_add` (`type` is the id; params default as below).",
    ...schema.effects.map((e) => `### \`${e.id}\`\n${e.description}\n\n${json(e.schema)}`),
  ].join("\n\n");
}
