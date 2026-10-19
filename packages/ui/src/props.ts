import type { Clip } from "@beacon/model";
import { replica } from "./store";

/** A clip's prop group as features read it: the group's defaults (`Init.propGroups`), then the clip's own values. */
export function propsOf<T extends object>(clip: Clip, group: string): T {
  const defaults = replica.get().init?.propGroups.find((g) => g.id === group)?.defaults;
  return { ...defaults, ...(clip.props[group] as object | undefined) } as T;
}
