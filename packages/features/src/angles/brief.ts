/** Where the camera goes for each angle, as Seedance's editing task is told it. */
export const VIEWS = {
  // The interview's second camera (the user, 2026-11-05, from an interview with an A and a B camera): off to one
  // side, a little tighter, the speaker still talking to the main camera, so they look just past this one.
  "three-quarter-left": { title: "Three-quarter, left", camera: "a second interview camera 35 degrees to the speaker's left at seated eye level, a medium close-up of head and shoulders, 85mm feel, shallow depth of field; they keep looking where they look in [Video1], so just past this lens" },
  "three-quarter-right": { title: "Three-quarter, right", camera: "a second interview camera 35 degrees to the speaker's right at seated eye level, a medium close-up of head and shoulders, 85mm feel, shallow depth of field; they keep looking where they look in [Video1], so just past this lens" },
  // From above and behind a shoulder (the user, 2026-11-05, from an interview's overhead cutaway): the mouth is
  // hardly seen, so the performance is held to, not the lips, as Detail.
  high: { title: "High angle", camera: "a high angle from above and a little behind the speaker's right shoulder, looking down at them and the desk in front of them, 35mm feel, the top of their head and their hands in view" },
  wide: { title: "Wide", camera: "a wide shot from further back and a little to one side, the speaker at their desk with the room around them, 28mm feel" },
  closeup: { title: "Close-up", camera: "a tight close-up of the speaker's face, eyes to chin, straight on at eye level, 85mm feel" },
  detail: { title: "Detail", camera: "a close detail shot of the speaker's hands and the desk in front of them, 85mm feel, shallow depth of field" },
} as const;
export type View = keyof typeof VIEWS;

/**
 * The brief Seedance re-films the take from: the angle's camera and move, the speech kept to [Audio1], the room
 * photos for the set only (their light, and where the desk is, from the take), and nothing retimed or added. Written
 * from what worked in the spike (PLAN's camera angles): naming what may change and locking the rest.
 */
export function brief(o: { view: View; move: "handheld" | "locked"; note: string; photos: number }): string {
  const images = Array.from({ length: o.photos }, (_, i) => `[Image${i + 1}]`).join(", ");
  return [
    "[Video1] is a take of a person speaking to camera at their desk; [Audio1] is what they say in it.",
    `Re-film this exact take as ${VIEWS[o.view].camera}.`,
    o.move === "handheld" ? "Handheld with micro-drift, easing, never locked off." : "Locked-off camera.",
    o.view === "detail" || o.view === "high" ? "Same performance and dialogue: every movement and gesture as in [Video1]." : "Same performance and dialogue: their lips move exactly to [Audio1], word for word and in time with it, from the first frame to the last.",
    "Camera placement and lens are the only things you are allowed to change: the same person and everything they wear, the room and the light, and every movement, gesture and blink stay exactly as they are in [Video1].",
    o.photos ? `${images} ${o.photos === 1 ? "is a photo" : "are photos"} of this same room: use them for its walls, furniture and their layout as seen from the new angle. They show the layout only: the light, colour and grade come from [Video1], and the desk sits where it is in [Video1], not where it is in the photos.` : "",
    o.note.trim() ? `Also: ${o.note.trim()}` : "",
    "Real-time playback: no speed change, no retiming, the same length. Naturalistic performance, real dialogue sync, no music. No captions, text, logos or graphics added.",
  ]
    .filter(Boolean)
    .join(" ");
}

/** The angle's camera, for a model shown one frame rather than the take. */
const cameraFor = (view: View) => VIEWS[view].camera.replace("[Video1]", "the first image");

/**
 * Wan's first step: one frame of the take shown again from the angle's camera (Wan 2.7 Image), since Wan 3.0 starts
 * its video on the frame it is given. A frame from the camera as it is would open every angle head on.
 */
export function stillBrief(o: { view: View; note: string; photos: number }): string {
  return [
    `The first image is a frame of a person speaking to camera at their desk. Show this same moment as ${cameraFor(o.view)}.`,
    "The same person and everything they wear, their expression, the room and the light; the room as seen from this side.",
    o.photos ? `The other ${o.photos === 1 ? "image is a photo" : "images are photos"} of this same room: use them for its walls, furniture and layout from the new angle; the light and colour stay as in the first image.` : "",
    o.note.trim() ? `Also: ${o.note.trim()}` : "",
    "A real photograph: no text, logos or graphics added.",
  ]
    .filter(Boolean)
    .join(" ");
}

/** Wan's second step: the re-framed still animated (Wan 3.0), the camera kept at its angle and the person talking on. */
export function motionBrief(o: { view: View; move: "handheld" | "locked"; note: string }): string {
  return [
    "A person at their desk talking naturally, in the shot this image is: the camera stays at this angle.",
    o.view === "detail" || o.view === "high" ? "They keep talking, with small natural gestures." : "They keep talking with small natural head movements and gestures, looking where they look in the image.",
    o.move === "handheld" ? "Handheld with micro-drift, easing, never locked off." : "Locked-off camera.",
    o.note.trim() ? `Also: ${o.note.trim()}` : "",
    "The same person, room and light throughout. Real time, naturalistic, no music. No camera orbit or zoom, no captions, text, logos or graphics.",
  ]
    .filter(Boolean)
    .join(" ");
}
