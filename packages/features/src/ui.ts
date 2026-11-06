import type { Clip } from "@beacon/model";
import { brollLabel } from "./broll/label";
import { calloutLabel } from "./callouts/label";
import { captionLabel } from "./captions/label";
import { regionLabel } from "./regions/label";

/**
 * What the editor window takes from the features: small pieces only, so its bundle doesn't carry every feature (the
 * motion catalogue, its libraries, the rooms' pictures) as importing the package would.
 */
export { POP_TERMS, type PopKind } from "./music/pops";
export { styleFromFile, type CustomStyle } from "./text-file";

/** A clip's label on the timeline from the feature it belongs to, when it has no media to be named after. */
export const clipLabel = (clip: Clip): string | undefined => calloutLabel(clip) ?? captionLabel(clip) ?? brollLabel(clip) ?? regionLabel(clip);
