/**
 * Flattens SVG path data (`d`) into polylines, enough for the sketch
 * callouts: M L H V C S Q T Z in both cases. Arcs are drawn as lines to
 * their end point.
 */
export function flattenPath(d: string, steps = 16): [number, number][][] {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? [];
  const lines: [number, number][][] = [];
  let line: [number, number][] = [];
  let i = 0;
  let cmd = "";
  let x = 0, y = 0, sx = 0, sy = 0;
  let cx = 0, cy = 0; // last control point, for S/T
  const num = () => Number(tokens[i++]);
  const isNum = () => i < tokens.length && !/[a-zA-Z]/.test(tokens[i]!);
  const push = (px: number, py: number) => {
    line.push([px, py]);
    x = px;
    y = py;
  };
  const cubic = (x1: number, y1: number, x2: number, y2: number, ex: number, ey: number) => {
    const [x0, y0] = [x, y];
    for (let k = 1; k <= steps; k++) {
      const t = k / steps, u = 1 - t;
      push(u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * ex, u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * ey);
    }
    cx = x2;
    cy = y2;
  };
  const quad = (x1: number, y1: number, ex: number, ey: number) => {
    const [x0, y0] = [x, y];
    for (let k = 1; k <= steps; k++) {
      const t = k / steps, u = 1 - t;
      push(u * u * x0 + 2 * u * t * x1 + t * t * ex, u * u * y0 + 2 * u * t * y1 + t * t * ey);
    }
    cx = x1;
    cy = y1;
  };
  while (i < tokens.length) {
    if (!isNum()) cmd = tokens[i++]!;
    const rel = cmd === cmd.toLowerCase();
    const ox = rel ? x : 0, oy = rel ? y : 0;
    switch (cmd.toUpperCase()) {
      case "M": {
        if (line.length > 1) lines.push(line);
        const px = num() + ox, py = num() + oy;
        line = [];
        push(px, py);
        sx = px;
        sy = py;
        cmd = rel ? "l" : "L";
        break;
      }
      case "L": push(num() + ox, num() + oy); break;
      case "H": push(num() + ox, y); break;
      case "V": push(x, num() + oy); break;
      case "C": { const a = [num() + ox, num() + oy, num() + ox, num() + oy, num() + ox, num() + oy] as const; cubic(...a); break; }
      case "S": { const r = [2 * x - cx, 2 * y - cy] as const; const a = [num() + ox, num() + oy, num() + ox, num() + oy] as const; cubic(r[0], r[1], ...a); break; }
      case "Q": { const a = [num() + ox, num() + oy, num() + ox, num() + oy] as const; quad(...a); break; }
      case "T": { const r = [2 * x - cx, 2 * y - cy] as const; quad(r[0], r[1], num() + ox, num() + oy); break; }
      case "A": { i += 5; push(num() + ox, num() + oy); break; }
      case "Z": push(sx, sy); lines.push(line); line = [[sx, sy]]; break;
      default: i++;
    }
    if (!"CcSsQqTt".includes(cmd)) {
      cx = x;
      cy = y;
    }
  }
  if (line.length > 1) lines.push(line);
  return lines;
}

/** The first `fraction` of the polylines' total length, in drawing order. */
export function trimLines(lines: [number, number][][], fraction: number): [number, number][][] {
  const total = lines.reduce((sum, l) => sum + length(l), 0);
  let left = total * Math.min(1, Math.max(0, fraction));
  const out: [number, number][][] = [];
  for (const l of lines) {
    if (left <= 0) break;
    const part: [number, number][] = [l[0]!];
    for (let k = 1; k < l.length && left > 0; k++) {
      const [a, b] = [l[k - 1]!, l[k]!];
      const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (seg <= left) {
        part.push(b);
        left -= seg;
      } else {
        const t = left / seg;
        part.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
        left = 0;
      }
    }
    out.push(part);
  }
  return out;
}

function length(l: [number, number][]): number {
  let n = 0;
  for (let k = 1; k < l.length; k++) n += Math.hypot(l[k]![0] - l[k - 1]![0], l[k]![1] - l[k - 1]![1]);
  return n;
}
