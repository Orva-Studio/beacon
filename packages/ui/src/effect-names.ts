/** Display names for effects; others show their id. */
const NAMES: Record<string, string> = {
  "round-corners": "Corner Rounding",
  "crt-monitor": "CRT Monitor",
  "drop-shadow": "Drop Shadow",
  "motion-blur": "Motion Blur",
  "cursor-shadow": "Cursor Shadow",
  "cursor-motion-blur": "Cursor Motion Blur",
  "cursor-physics": "Cursor Physics",
  "click-scaling": "Click Scaling",
};

export const effectName = (type: string) => NAMES[type] ?? type;
