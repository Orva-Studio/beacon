import { z } from "zod";
import { clipSpeed } from "../evaluate";
import { clone, copyClips } from "../edit";
import { secondsToTicks, ticksToSeconds } from "../ticks";
import { topClips, sessionCommand, type Session, type SessionCommandDef, type CopiedProperties } from "./shared";

export const CLIPBOARD_COMMANDS: SessionCommandDef[] = [
  sessionCommand({
    id: "effect.select",
    description: "Select effects (their bars on a clip opened with its arrow) and their clips; `add` adds to the selected effects (⇧/⌘-click); no effects deselects them",
    args: z.strictObject({ effects: z.array(z.strictObject({ clip: z.string(), id: z.string() })), add: z.boolean().default(false) }),
    apply: (s, { effects, add }, { project }) => {
      const clips = topClips(project).map((x) => x.clip);
      for (const e of effects) if (!clips.find((c) => c.id === e.clip)?.effects.some((fx) => fx.id === e.id)) throw new Error(`no effect "${e.id}" on clip "${e.clip}"`);
      const key = (e: { clip: string; id: string }) => `${e.clip}/${e.id}`;
      const next = add ? [...s.effects.filter((e) => !effects.some((x) => key(x) === key(e))), ...effects] : effects;
      s.effects = next;
      s.animation = null;
      if (effects.length) {
        s.selection = [...new Set([...(add ? s.selection : []), ...next.map((e) => e.clip)])];
        s.inspector = "effects";
      }
    },
  }),
  sessionCommand({
    id: "animation.copy",
    description: "Copy the selected animation arrow (⌘C with an arrow selected) for pasting onto other clips (⌘V), kept as copied properties",
    args: z.strictObject({}),
    apply: (s, _, { project }) => {
      const sel = s.animation;
      const clip = sel && topClips(project).find((x) => x.clip.id === sel.clip)?.clip;
      const anim = clip?.animations.find((a) => a.id === sel!.id);
      if (!clip || !anim) throw new Error("select an animation arrow first");
      const speed = clipSpeed(clip);
      const offset = ticksToSeconds((anim.end - anim.duration - (clip.mediaStart ?? 0)) / speed);
      s.properties = clone({ props: {}, effects: [], animations: [{ offset, duration: ticksToSeconds(anim.duration / speed), easing: anim.easing, to: anim.to }] });
      s.clipboard = null;
    },
  }),
  sessionCommand({
    id: "effects.copy",
    description: "Copy the selected effects (⌘C with effects selected) for pasting onto other clips (⌘V); they are kept as copied properties with no prop groups",
    args: z.strictObject({}),
    apply: (s, _, { project }) => {
      const clips = topClips(project).map((x) => x.clip);
      const effects = s.effects.flatMap((e) => clips.find((c) => c.id === e.clip)?.effects.filter((fx) => fx.id === e.id) ?? []);
      if (!effects.length) throw new Error("select effects first");
      // The span is the copied clip's media time; on another clip the effect covers it whole.
      s.properties = clone({ props: {}, effects: effects.map(({ span: _, ...fx }) => fx) });
      s.clipboard = null;
    },
  }),
  sessionCommand({
    id: "clipboard.copy",
    description:
      "Copy clips for `clip.paste`: the given clips, else the selection, else what every unlocked track holds in the in/out range (⌘C). Cut is a copy then `clip.remove`",
    args: z.strictObject({ clips: z.array(z.string()).optional() }),
    apply: (s, { clips }, { project, registry }) => {
      const ids = clips ?? (s.selection.length ? s.selection : undefined);
      const range = s.range ? ([secondsToTicks(s.range.in), secondsToTicks(s.range.out)] as [number, number]) : undefined;
      const board = copyClips(project, ids ? { clips: ids } : { range }, registry);
      if (!board) throw new Error("nothing to copy: select clips or set an in/out range");
      s.clipboard = board as Session["clipboard"];
    },
  }),
  sessionCommand({
    id: "properties.copy",
    description:
      "Copy a clip's properties (transform, crop, cursor, audio, callout style... and its effects) for `clip.pasteProperties`: the given clip, else the first selected one (Copy Properties, ⇧⌘C)",
    args: z.strictObject({ clip: z.string().optional() }),
    apply: (s, { clip }, { project, registry }) => {
      const id = clip ?? s.selection[0];
      const c = topClips(project).find((x) => x.clip.id === id)?.clip;
      if (!c) throw new Error(id ? `no clip "${id}" on the timeline` : "select a clip first");
      // Which stream it shows and a group's own tracks belong to the clip, not its look.
      const own = new Set(registry.groupsFor(c.type).filter((g) => g.nested || g.identity).map((g) => g.id));
      const props = Object.fromEntries(Object.entries(c.props).filter(([k]) => !own.has(k))) as CopiedProperties["props"];
      s.properties = clone({ props, effects: c.effects, type: c.type });
    },
  }),
];
