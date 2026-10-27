/** What Copy ID copies: the selection's ids when `clip` is in it (or none is named), else that clip's, comma-separated. */
export const copiedIds = (selection: string[], clip?: string): string => (clip && !selection.includes(clip) ? [clip] : selection).join(", ");
