# House style (measured from the user's projects)

Measured over 38 projects in `~/client-videos` (2026-10-08). Use these
defaults unless asked otherwise.

- **Canvas:** 1920x1080 @ 30 fps (30 of 40 projects); a few 1080x1920
  shorts.
- **Screen recording** (3600x2336 on the user's display): most often scale
  0.52 at x -24, y 63 (transform props; x/y are canvas pixels from the
  centre, y up), i.e. slightly larger than fit, nudged up-left. Imports start
  fitted (scale 0.462).
- **Camera** (3840x2160): either full frame (scale 0.5, centred) for talking
  head sections, or a picture-in-picture strip on the right: scale 0.30,
  x ≈ 740, y ≈ 6, cropped to a portrait strip around the face (crop left
  ≈ 1370, right ≈ 1350, top ≈ 168, bottom ≈ 127, in camera pixels; the left/
  right split depends on where the user sits) with the round-corners effect.
  Check with `frame_at` that the face is inside the crop.
- **Track order** (bottom to top): screen, camera, audio.
- **Zooms:** transform animation blocks, linear, mostly 0.2-0.4 s long; slow
  push-ins of 3-7 s also occur.
