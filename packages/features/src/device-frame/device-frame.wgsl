// device-frame params (canvas pixels unless said):
//  0-8   frame pixel → screen point, a 3×3 homography (row-major)
//  9-11  the screen point's depth: z = p9·x + p10·y + p11
//  12    the depth in focus
//  13    aperture: the blur, in canvas px, of a point twice as far as the focus
//  14    the room's depth
//  15-18 the bezel's edges around the screen: left, top, right, bottom
//  19    the screen's width, 20 its height; 29-30 its top-left corner (the recording's place on the canvas)
//  21    the largest blur (sigma)
//  22-24 device-pixels' own (below)
//  25    chromatic aberration at the frame's corners
//  26-27 the focus point on the screen, 28 how far from it the screen stays sharp (screen px)
//  31    the rim's width round the bezel

fn df_screen_point(uv: vec2<f32>) -> vec2<f32> {
  let p = to_layer(uv);
  let w = param(6u) * p.x + param(7u) * p.y + param(8u);
  return vec2(param(0u) * p.x + param(1u) * p.y + param(2u), param(3u) * p.x + param(4u) * p.y + param(5u)) / w;
}

// What the frame shows at `uv`: 2 the screen, 1 the bezel and its rim, 0 the room.
fn df_region(uv: vec2<f32>) -> i32 {
  let s = df_screen_point(uv) - vec2(param(29u), param(30u));
  let size = vec2(param(19u), param(20u));
  if (all(s >= vec2(0.0)) && all(s <= size)) {
    return 2;
  }
  let rim = param(31u);
  if (s.x > -param(15u) - rim && s.y > -param(16u) - rim && s.x < size.x + param(17u) + rim && s.y < size.y + param(18u) + rim) {
    return 1;
  }
  return 0;
}

// The blur (sigma, target px) where the frame shows `uv`: on the screen by its depth there, the room by its own; the
// bezel stays sharp, so its edge is the same thin line at any Blur (the user, 2026-11-05).
fn df_sigma(uv: vec2<f32>) -> f32 {
  let region = df_region(uv);
  if (region == 1) {
    return 0.0;
  }
  let s = df_screen_point(uv);
  var z = param(14u);
  var falloff = 0.0;
  if (region == 2) {
    z = param(9u) * s.x + param(10u) * s.y + param(11u);
    // Head on, the screen is all one distance away, so optics alone would keep it all sharp: the screen softens with
    // distance from the focus (the cursor) instead, the look the user asked for.
    let d = distance(s, vec2(param(26u), param(27u)));
    falloff = param(13u) * 0.3 * smoothstep(param(28u), param(28u) * 3.0, d);
  }
  let coc = max(param(13u) * abs(z - param(12u)) / max(z, 1.0), falloff);
  return min(coc, param(21u)) * frame.layer.z;
}

// The screen's own pixels, on the same params as device-frame: 22 recording pixels per canvas pixel, 23 strength,
// 24 the surface (1 matte).

// How much of [0, x] a stripe of half-width `a` centred at `c` in every unit cell lights (c - a >= 0, c + a <= 1).
fn px_lit(x: f32, c: f32, a: f32) -> f32 {
  return floor(x) * 2.0 * a + clamp(fract(x) - (c - a), 0.0, 2.0 * a);
}

// The stripe's share of the `w` wide stretch centred at `x`, over its share of the whole: 1 on average, so the
// picture keeps its brightness however small the stripes get.
fn px_cover(x: f32, w: f32, c: f32, a: f32) -> f32 {
  return (px_lit(x + w * 0.5, c, a) - px_lit(x - w * 0.5, c, a)) / (w * 2.0 * a);
}

fn px_hash(p: vec2<f32>) -> f32 {
  var p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// An LCD's subpixels at the recording's own pixel size: red, green and blue stripes in each pixel, a dark line between
// rows. Drawn on the finished frame, so at any angle and zoom it is at the output's resolution. Each output pixel takes
// the stripes' average over its own footprint (not their value at its centre), in linear light, so they melt into the
// picture as they get small instead of beating against the output's grid (moiré), and a grey stays the same grey.
// Where the focus blur is wider than a pixel the grid is left out: the lens would have averaged it away.
@fragment
fn fs_pixels(v: VOut) -> @location(0) vec4<f32> {
  let c = textureSampleLevel(src, samp, v.uv, 0.0);
  let s = df_screen_point(v.uv) - vec2(param(29u), param(30u));
  let r = s * param(22u);
  // Recording pixels per output pixel, across and down, from how far a pixel step moves in the recording.
  let span = max(vec2(length(vec2(dpdx(r.x), dpdy(r.x))), length(vec2(dpdx(r.y), dpdy(r.y)))), vec2(1e-4));
  let scale = 1.0 / span;
  if (s.x < 0.0 || s.y < 0.0 || s.x > param(19u) || s.y > param(20u)) {
    return c;
  }
  // Strength 0 to 0.5 brings the grid in; past 0.5 it goes to extremes: thinner stripes with black between them,
  // darker and wider lines between rows, showing from further away.
  let k = param(23u) * 2.0;
  let extra = clamp(k - 1.0, 0.0, 1.0);
  let sharp = 1.0 - smoothstep(0.3, 1.0, df_radius(v.uv) / min(scale.x, scale.y));
  let across = min(k, 1.0) * smoothstep(2.5 - extra, 6.0 - 2.5 * extra, scale.x) * sharp;
  let down = min(k, 1.0) * smoothstep(2.0 - 0.8 * extra, 5.0 - 2.0 * extra, scale.y) * sharp * (0.8 + 0.2 * extra);
  if (across <= 0.0 && down <= 0.0) {
    return c;
  }
  let w = max(span, vec2(0.06));
  let a = 0.112 - 0.04 * extra;
  let stripes = vec3(px_cover(r.x, w.x, 1.0 / 6.0, a), px_cover(r.x, w.x, 0.5, a), px_cover(r.x, w.x, 5.0 / 6.0, a));
  let gap = 0.09 + 0.06 * extra;
  let rows = px_cover(r.y, w.y, 0.5, 0.5 - gap);
  let mask = mix(vec3(1.0), stripes, across) * mix(1.0, rows, down);
  // A stripe can be no brighter than white, so where the picture is too bright for its stripes to carry all of its
  // light the gaps between them fill in instead (a bright screen flares over its own grid): the picture keeps its
  // brightness at any strength, and the grid fades toward white as it does in an exposed photo.
  let peak = mix(1.0, 0.5 / a, across) * mix(1.0, 1.0 / (1.0 - 2.0 * gap), down);
  let light = c.rgb * c.rgb;
  let fill = max((light - 1.0 / peak) / (1.0 - 1.0 / peak), vec3(0.0));
  var lin = fill + min(light, (1.0 - fill) / peak) * mask;
  // A matte coating's sparkle: each subpixel a touch brighter or dimmer through the grain of the anti-glare layer,
  // once a subpixel is a couple of output pixels wide.
  let cell = floor(vec2(r.x * 3.0, r.y));
  lin *= 1.0 + 0.16 * (px_hash(cell) - 0.5) * param(24u) * across * smoothstep(6.0, 12.0, scale.x);
  return vec4(sqrt(min(lin, vec3(c.a * c.a))), c.a);
}

// The frame as light: display values to linear (a gamma of 2, near enough and exact both ways), highlights opened up
// past white by `open`, since a room's lamps are far brighter than the grey beside them and a camera only clips them
// (the screen's whites less so: it is what the camera is exposed for). Blurred as light, a bright point stays a
// bright disc (bokeh) instead of fading to a grey smudge.
fn df_open(region: i32) -> f32 {
  return select(0.82, 0.3, region == 2);
}

fn df_light(c: vec4<f32>, open: f32) -> vec4<f32> {
  let lin = c.rgb * c.rgb;
  let m = min(max(max(lin.r, lin.g), lin.b), 1.0);
  return vec4(lin / (1.0 - open * m), c.a);
}

fn df_display(c: vec4<f32>, open: f32) -> vec4<f32> {
  let m = max(max(c.r, c.g), c.b);
  return vec4(sqrt(c.rgb / (1.0 + open * m)), c.a);
}

// The blur disc's radius (target px): a lens's blur is a disc, twice as wide as the Gaussian of the same spread.
fn df_radius(uv: vec2<f32>) -> f32 {
  return df_sigma(uv) * 2.0;
}

fn df_taps(radius: f32) -> i32 {
  return i32(clamp(radius * radius * 1.2 + 12.0, 12.0, 56.0));
}

// A different turn of the taps at each pixel, so too few taps show as fine noise (which the second step smooths)
// rather than as rings or copies of the picture.
fn df_turn(uv: vec2<f32>) -> f32 {
  return 6.2831853 * px_hash(floor(uv * target_size()));
}

// The focus blur: the light of a disc round each pixel (a golden-angle spiral of taps), a little brighter toward its
// rim as a fast lens's is. Green's disc is a touch wider than red's and blue's (a lens focuses each colour at its own
// distance), so what is out of focus gets a faint green edge. Only what is in the same part of the frame: the dark
// bezel would otherwise spread over the room and the picture's edge as the blur grows, a halo round the monitor.
@fragment
fn fs_bokeh(v: VOut) -> @location(0) vec4<f32> {
  let radius = df_radius(v.uv);
  let c = textureSampleLevel(src, samp, v.uv, 0.0);
  if (radius < 0.6) {
    return c;
  }
  let region = df_region(v.uv);
  let open = df_open(region);
  let n = df_taps(radius);
  let turn = df_turn(v.uv);
  let px = radius / target_size();
  let narrow = 1.0 - 0.04 * min(param(25u), 1.0);
  var acc = vec4(0.0);
  var wsum = vec4(0.0);
  for (var i = 0; i < n; i++) {
    let k = sqrt((f32(i) + 0.5) / f32(n));
    let ang = f32(i) * 2.3999632 + turn;
    let at = v.uv + vec2(cos(ang), sin(ang)) * k * px;
    let same = select(0.0, 1.0, df_region(at) == region) * (0.94 + 0.12 * k * k);
    let side = 1.0 - smoothstep(narrow - 0.06, narrow, k);
    let w = same * vec4(side, 1.0, side, 1.0);
    acc += df_light(textureSampleLevel(src, samp, at, 0.0), open) * w;
    wsum += w;
  }
  if (wsum.r <= 0.0) {
    return c;
  }
  return df_display(acc / wsum, open);
}

// The blur's second step: each pixel with its neighbours a tap's spacing away, which closes the gaps between the
// first step's taps.
@fragment
fn fs_bokeh_fill(v: VOut) -> @location(0) vec4<f32> {
  let radius = df_radius(v.uv);
  let c = textureSampleLevel(src, samp, v.uv, 0.0);
  if (radius < 0.6) {
    return c;
  }
  let region = df_region(v.uv);
  let open = df_open(region);
  let px = radius * 1.4 / sqrt(f32(df_taps(radius))) / target_size();
  let turn = df_turn(v.uv + vec2(0.37, 0.61));
  var acc = df_light(c, open);
  var wsum = 1.0;
  for (var i = 0; i < 12; i++) {
    let k = sqrt((f32(i) + 0.5) / 12.0);
    let ang = f32(i) * 2.3999632 + turn;
    let at = v.uv + vec2(cos(ang), sin(ang)) * k * px;
    let w = select(0.0, 1.0, df_region(at) == region);
    acc += df_light(textureSampleLevel(src, samp, at, 0.0), open) * w;
    wsum += w;
  }
  return df_display(acc / wsum, open);
}

// Red and blue pulled apart toward the frame's corners, as a fast lens does.
@fragment
fn fs_fringe(v: VOut) -> @location(0) vec4<f32> {
  let off = (v.uv - 0.5) * 2.0;
  let shift = off * dot(off, off) * 0.5 * param(25u) * frame.layer.z / target_size();
  let g = textureSampleLevel(src, samp, v.uv, 0.0);
  let r = textureSampleLevel(src, samp, v.uv + shift, 0.0).r;
  let b = textureSampleLevel(src, samp, v.uv - shift, 0.0).b;
  return vec4(r, g.g, b, g.a);
}

// device-screen params: the surface (0 matte, 1 glossy), the screen's width and height (layer px), the camera's place
// over the screen (layer px: across, down, and how far in front).
// Glossy: a touch more contrast (its reflection is a layer of its own, device-reflection); matte: a faint haze that
// lifts the blacks, as an anti-glare coating does. An LCD seen from the side: dimmer the further off its axis each
// point is seen, its blacks lifting to a faint glow (IPS glow), so the far side of a turned screen falls away.
@fragment
fn fs_screen(v: VOut) -> @location(0) vec4<f32> {
  let c = textureSampleLevel(src, samp, v.uv, 0.0);
  let at = to_layer(v.uv);
  let p = at / vec2(param(1u), param(2u));
  let glossy = param(0u);
  let haze = vec3(0.035, 0.032, 0.03) * (1.0 - glossy);
  var rgb = c.rgb;
  rgb = mix(rgb, (rgb - 0.5 * c.a) * 1.05 + 0.5 * c.a, glossy);
  let cam = vec3(param(3u), param(4u), param(5u));
  let off_axis = 1.0 - cam.z / length(vec3(at - cam.xy, cam.z));
  // The backlight, a little dimmer toward the panel's edges and corners.
  let u = abs(p * 2.0 - 1.0);
  let backlight = 1.0 - 0.05 * (pow(u.x, 4.0) + pow(u.y, 4.0));
  rgb *= backlight * pow(1.0 - off_axis, 0.55);
  let glow = vec3(0.05, 0.047, 0.058) * smoothstep(0.02, 0.5, off_axis);
  // The panel's backlight bleeding a little along its edges, so a dark picture still meets the black bezel at a line.
  let edge = min(min(p.x, 1.0 - p.x) * param(1u), min(p.y, 1.0 - p.y) * param(2u));
  let bleed = vec3(0.05, 0.06, 0.08) * exp(-max(edge, 0.0) / (0.002 * param(1u)));
  rgb = rgb + (haze + bleed + glow) * (vec3(c.a) - rgb);
  return vec4(clamp(rgb, vec3(0.0), vec3(c.a)), c.a);
}

// A pixel's ray from the camera into the room, from the camera's axes at params `a` to `a + 8` (columns of its
// rotation) and its focal length and frame shape (over the frame's height) at `a + 9` and `a + 10`.
fn dp_ray(uv: vec2<f32>, a: u32) -> vec3<f32> {
  let c = vec3((uv.x - 0.5) * param(a + 10u), uv.y - 0.5, param(a + 9u));
  let x = vec3(param(a), param(a + 1u), param(a + 2u));
  let y = vec3(param(a + 3u), param(a + 4u), param(a + 5u));
  let z = vec3(param(a + 6u), param(a + 7u), param(a + 8u));
  return normalize(vec3(dot(x, c), dot(y, c), dot(z, c)));
}

// Where a direction in the room is in an equirectangular panorama whose `centre` (a share across) is behind the
// monitor (+z), y down.
fn dp_uv(w: vec3<f32>, centre: f32) -> vec2<f32> {
  let lon = atan2(w.x, w.z);
  let lat = asin(clamp(w.y, -1.0, 1.0));
  return vec2(fract(centre + lon / 6.2831853), 0.5 + lat / 3.1415927);
}

// device-panorama params: 0-10 the camera (dp_ray), 11 the share across the picture behind the monitor, 12 lift,
// 13 how much colour it keeps, 14 the picture (0 a 360° panorama, 1 a flat photo), 15-16 a photo's spread across and
// down (radians). The layer is the whole picture stretched over the frame: each pixel looks into it along its own ray,
// so the room turns as the camera does; a photo is mirrored past its edges, far out of focus.
@fragment
fn fs_panorama(v: VOut) -> @location(0) vec4<f32> {
  let w = dp_ray(v.uv, 0u);
  var at = dp_uv(w, param(11u));
  if (param(14u) > 0.5) {
    let lon = atan2(w.x, w.z);
    let lat = asin(clamp(w.y, -1.0, 1.0));
    let u = vec2(0.5 + lon / param(15u), 0.5 + lat / param(16u));
    at = 1.0 - abs(fract(u * 0.5) * 2.0 - 1.0);
  }
  let c = textureSampleLevel(src, samp, at, 0.0);
  let lifted = min(c.rgb * param(12u), vec3(1.0));
  let grey = vec3(dot(lifted, vec3(0.2126, 0.7152, 0.0722)));
  return vec4(mix(grey, lifted, param(13u)), 1.0);
}

// device-reflection params: the glass in the plate's pixels (left, top, width, height), strength (head on), the
// glass's corner radius (plate px), the blur's radius (plate px), the camera's place over the plate (plate px: across,
// down, and how far in front), daylight (1 by day). The room behind the camera, kept to the glass and added as light (alpha 0 adds under
// premultiplied blending), as glass reflects: about as much at any angle up to 45° or so, then more and more toward
// grazing (Fresnel), so across a turned screen the far side mirrors the room most.
@fragment
fn fs_reflection(v: VOut) -> @location(0) vec4<f32> {
  let at = to_layer(v.uv);
  let p = at - vec2(param(0u), param(1u));
  let half_size = vec2(param(2u), param(3u)) * 0.5;
  let r = param(5u);
  let q = abs(p - half_size) - half_size + r;
  let d = length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - r;
  let aa = max(fwidth(d), 1e-3);
  let inside = 1.0 - smoothstep(-aa, aa, d);
  let cam = vec3(param(7u), param(8u), param(9u));
  let grazing = 1.0 - cam.z / length(vec3(at - cam.xy, cam.z));
  let fresnel = min(1.0 + 24.0 * pow(grazing, 5.0) + 2.0 * grazing * grazing, 6.0);
  // Blurred by a disc of taps (a golden-angle spiral).
  let radius = param(6u) * frame.layer.z / target_size();
  var c = textureSampleLevel(src, samp, v.uv, 0.0);
  if (param(6u) > 0.0) {
    c = vec4(0.0);
    for (var i = 0; i < 24; i++) {
      let k = sqrt((f32(i) + 0.5) / 24.0);
      let a = f32(i) * 2.3999632;
      c += textureSampleLevel(src, samp, v.uv + vec2(cos(a), sin(a)) * radius * k, 0.0);
    }
    c /= 24.0;
  }
  // Daylight: a window is many times brighter than the wall beside it, which a photo of the room can't hold, so the
  // picture's bright parts are opened up and its dark parts held back. The window then washes the screen pale while
  // what stands in front of it (a person, shelves) leaves a clear patch, as glass does by a window.
  let sky = max(max(c.r, c.g), c.b);
  let lit = mix(c.rgb, c.rgb * (0.25 + 2.4 * smoothstep(0.5, 0.95, sky)), param(10u));
  return vec4(lit * param(4u) * fresnel * inside, 0.0);
}

// device-rim params: the lamp's colour (r, g, b), strength, the lit band's width (layer px), the near side (0 left,
// 1 right), the layer's width and height. The bezel catches the room's warm light along its top and its side nearest
// the camera, so it sits in the room rather than on it.
@fragment
fn fs_rim(v: VOut) -> @location(0) vec4<f32> {
  let c = textureSampleLevel(src, samp, v.uv, 0.0);
  let p = to_layer(v.uv);
  let size = vec2(param(6u), param(7u));
  let band = max(param(4u), 1.0);
  let top = exp(-p.y / band);
  let x = select(p.x, size.x - p.x, param(5u) > 0.5);
  let near = exp(-x / band) * 0.7;
  let light = vec3(param(0u), param(1u), param(2u)) * param(3u) * clamp(top + near, 0.0, 1.0);
  return vec4(c.rgb + light * c.a, c.a);
}

// device-room params: the room (0 drawn dark, 1 a photo), then for a photo its lift and how much of its colour it keeps
// (the photo is dim, and a grade's contrast and vignette would sink it); for the dark room the camera's turn (sin of
// its yaw), its warm lamp's falloff coming from the side away from the camera.
@fragment
fn fs_room(v: VOut) -> @location(0) vec4<f32> {
  let c = textureSampleLevel(src, samp, v.uv, 0.0);
  if (param(0u) > 0.5) {
    let lifted = min(c.rgb * param(1u), vec3(c.a));
    let grey = vec3(dot(lifted, vec3(0.2126, 0.7152, 0.0722)));
    return vec4(mix(grey, lifted, param(2u)), c.a);
  }
  let lamp = vec2(0.5 - param(1u) * 0.6, 0.1);
  let d = distance(v.uv * vec2(1.6, 1.0), lamp * vec2(1.6, 1.0));
  let warm = vec3(0.16, 0.1, 0.055) * exp(-d * d / 0.18);
  let floor = mix(1.0, 0.7, smoothstep(0.5, 1.0, v.uv.y));
  return vec4((c.rgb + warm * c.a) * floor, c.a);
}
