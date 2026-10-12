/** Display names for the visual effects; others show their id. */
const NAMES: Record<string, string> = { "round-corners": "Corner Rounding", "crt-monitor": "CRT Monitor", "drop-shadow": "Drop Shadow", "motion-blur": "Motion Blur" };

export const effectName = (type: string) => NAMES[type] ?? type;
