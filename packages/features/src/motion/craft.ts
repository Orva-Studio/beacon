/**
 * How a motion designer would make it: what the author is told beside the contract. Condensed from HyperFrames' motion
 * rules (its prompting guide's shared preamble and its skill's motion reference, Apache 2.0), which made the graphics
 * Beacon was compared with.
 */
export const CRAFT = `Craft, as a senior motion designer would:
- Density: one focal element at display scale; supporting elements come in on their own cues; chrome (labels, rules, small tags) stays put.
- Depth: three layers (a background with texture or light, the focal layer, a foreground accent such as particles or glints), moving at different speeds under one slow continuous camera drift, so nothing is ever fully still.
- Ease by role: arrivals land on a long tail (expo.out, power4.out); camera moves and colour floods ease both ways (power2.inOut); exits and zooms through accelerate (power3.in), 40-50% shorter than their entrance. Linear only for rotation, progress and counters' constant speed. The same power2.out on everything looks generated.
- Overshoot (back.out(1.4), elastic.out(1, 0.5)) on position and scale only, never on opacity or colour.
- Overlap: each element starts when the one before is 30-50% done. Stagger letters a frame apart, words 60-120 ms, list items 40-80 ms.
- Fast moves take 0.3-0.6 s and carry motion blur peaking mid-move (filter: blur, 6-12 px on text, more full-frame, horizontal on a horizontal move).
- Vary entrances: per word blur 6 px to 0 with opacity, per word grey to ink, a whole line blurring in, letters for a name, a word rolling like a slot machine; not every element fading and sliding up.
- Holds: a line to read holds 0.5 s plus 0.3 s a word; the last frame holds at least 1-2 s. Landed titles stay put; the life moves to the background (an ambient idle: drifting light, slow particles, a gentle camera), never a frozen final frame.
- Spectacle: one exaggerated beat (a burst, a flash, a shockwave, a bloom) where the brief places it or where the piece pays off; everything else restrained. A burst is seeded so every render is identical.
- Detail sells it: a fine grid or grain, a soft glow behind the focal element, a thin rule, a small label chip, real-looking UI (icons drawn in SVG), proper typography (tight tracking on big type, tabular numbers on counters).`;
