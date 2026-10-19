import type { ActionContext, ActionStep } from "./feature";
import type { Clip } from "./schema";

/** The selected clips that still exist, on the timeline or in the opened group. */
export function selectedClips({ scope, session }: ActionContext): Clip[] {
  return scope.tracks.flatMap((t) => t.clips.filter((c) => session.selection.includes(c.id)));
}

/**
 * The clips a panel item dropped on `clip` applies to (a drag onto
 * media): every selected clip when it is one of them, else that clip alone;
 * without `clip`, the selection.
 */
export function dropTargets(ctx: ActionContext, clip?: string): Clip[] {
  if (!clip) return selectedClips(ctx);
  if (ctx.session.selection.includes(clip)) return selectedClips(ctx);
  const c = ctx.scope.tracks.flatMap((t) => t.clips).find((x) => x.id === clip);
  if (!c) throw new Error(`no clip "${clip}"${ctx.scope.group ? " in the open group" : " on the timeline"}`);
  return [c];
}

/** After a drop on an unselected clip, it becomes the selection, so its properties show what was added. */
export const selectDropped = (ctx: ActionContext, clip?: string): ActionStep[] =>
  clip && !ctx.session.selection.includes(clip) ? [{ command: "selection.set", args: { clips: [clip], linked: false } }] : [];
