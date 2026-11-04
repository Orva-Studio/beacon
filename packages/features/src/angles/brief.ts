/** Where the camera goes for each angle, as Seedance's editing task is told it. */
export const VIEWS = {
  "profile-left": { title: "Side profile, left", camera: "a true 90-degree side profile of the speaker at seated eye level, from their left side, 50mm feel" },
  "profile-right": { title: "Side profile, right", camera: "a true 90-degree side profile of the speaker at seated eye level, from their right side, 50mm feel" },
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
    o.view === "detail" ? "Same performance and dialogue: every movement and gesture as in [Video1]." : "Same performance and dialogue: their lips move exactly to [Audio1], word for word and in time with it, from the first frame to the last.",
    "Camera placement and lens are the only things you are allowed to change: the same person and everything they wear, the room and the light, and every movement, gesture and blink stay exactly as they are in [Video1].",
    o.photos ? `${images} ${o.photos === 1 ? "is a photo" : "are photos"} of this same room: use them for its walls, furniture and their layout as seen from the new angle. They show the layout only: the light, colour and grade come from [Video1], and the desk sits where it is in [Video1], not where it is in the photos.` : "",
    o.note.trim() ? `Also: ${o.note.trim()}` : "",
    "Real-time playback: no speed change, no retiming, the same length. Naturalistic performance, real dialogue sync, no music. No captions, text, logos or graphics added.",
  ]
    .filter(Boolean)
    .join(" ");
}
