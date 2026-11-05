// device-frame params (canvas pixels unless said):
//  0-8   frame pixel → screen point, a 3×3 homography (row-major)
//  9-11  the screen point's depth: z = p9·x + p10·y + p11
//  12    the depth in focus
//  13    aperture: the blur, in canvas px, of a point twice as far as the focus
//  14    the room's depth
//  15-18 the bezel's edges around the screen: left, top, right, bottom
//  19    the screen's width, 20 its height; 29-30 its top-left corner (the recording's place on the canvas)
//  21    the largest blur (sigma)
//  22-24 unused
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

// device-pixels params: 0-8 frame pixel → screen point (as device-frame's), 9-10 the screen's top-left corner, 11-12
// its width and height (canvas px), 13 recording pixels per canvas pixel, 14 strength.
// An LCD's subpixels at the recording's own pixel size: red, green and blue stripes in each pixel, a dark line between
// rows. Drawn on the finished frame, so at any angle and zoom it is at the output's resolution; each part fades out
// before it gets smaller than a few output pixels, so it never shimmers (moiré). The focus blur comes after.
@fragment
fn fs_pixels(v: VOut) -> @location(0) vec4<f32> {
  let c = textureSampleLevel(src, samp, v.uv, 0.0);
  let o = vec2(param(9u), param(10u));
  let r = (df_screen_point(v.uv) - o) * param(13u);
  // Output pixels per recording pixel, across and down, from how far a pixel step moves in the recording.
  let span = vec2(length(vec2(dpdx(r.x), dpdy(r.x))), length(vec2(dpdx(r.y), dpdy(r.y))));
  let scale = 1.0 / max(span, vec2(1e-4));
  let s = df_screen_point(v.uv) - o;
  if (s.x < 0.0 || s.y < 0.0 || s.x > param(11u) || s.y > param(12u)) {
    return c;
  }
  // Strength 0 to 0.5 brings the grid in; past 0.5 it goes to extremes: thinner stripes with black between them,
  // darker and wider lines between rows, showing from further away (a little moiré allowed at the very top).
  let k = param(14u) * 2.0;
  let extra = clamp(k - 1.0, 0.0, 1.0);
  let across = min(k, 1.0) * smoothstep(2.5 - extra, 6.0 - 2.5 * extra, scale.x);
  let down = min(k, 1.0) * smoothstep(2.0 - 0.8 * extra, 5.0 - 2.0 * extra, scale.y);
  let f = fract(r);
  let d = abs(fract(vec3(f.x) - vec3(1.0 / 6.0, 0.5, 5.0 / 6.0) + 0.5) - 0.5);
  let stripe = 1.0 - smoothstep(vec3(0.09 - 0.05 * extra), vec3(1.0 / 6.0 - 0.05 * extra), d);
  let band = 0.14 + 0.12 * extra;
  let row = smoothstep(0.0, band, f.y) * (1.0 - smoothstep(1.0 - band, 1.0, f.y));
  // Brighter where lit, so the stripes' average stays near the picture's own brightness.
  let mask = mix(vec3(1.0), stripe * (2.2 + 1.3 * extra), across) * mix(1.0, row, down * (0.8 + 0.2 * extra));
  return vec4(min(c.rgb * mask, vec3(c.a)), c.a);
}

fn df_blur(uv: vec2<f32>, dir: vec2<f32>, sigma: f32) -> vec4<f32> {
  if (sigma < 0.3) {
    return textureSampleLevel(src, samp, uv, 0.0);
  }
  // Up to 25 taps a side, spread out for wide blurs: soft enough, and a frame stays cheap.
  let spread = max(1.0, sigma * 3.0 / 25.0);
  let px = dir / target_size() * spread;
  let n = i32(min(ceil(sigma * 3.0 / spread), 25.0));
  let s = sigma / spread;
  // Only what is in the same part of the frame: the dark bezel would otherwise spread over the room and the
  // picture's edge as the blur grows, a halo round the monitor.
  let region = df_region(uv);
  var acc = vec4(0.0);
  var wsum = 0.0;
  for (var k = -n; k <= n; k++) {
    let at = uv + px * f32(k);
    let w = exp(-f32(k * k) / (2.0 * s * s)) * select(0.0, 1.0, df_region(at) == region);
    acc += textureSampleLevel(src, samp, at, 0.0) * w;
    wsum += w;
  }
  return acc / max(wsum, 1e-6);
}

@fragment
fn fs_dof_h(v: VOut) -> @location(0) vec4<f32> {
  return df_blur(v.uv, vec2(1.0, 0.0), df_sigma(v.uv));
}

// The second half of the blur, red and blue pulled apart toward the corners as a fast lens does.
@fragment
fn fs_dof_v(v: VOut) -> @location(0) vec4<f32> {
  let sigma = df_sigma(v.uv);
  let off = (v.uv - 0.5) * 2.0;
  let shift = off * dot(off, off) * 0.5 * param(25u) * frame.layer.z / target_size();
  let g = df_blur(v.uv, vec2(0.0, 1.0), sigma);
  let r = df_blur(v.uv + shift, vec2(0.0, 1.0), sigma).r;
  let b = df_blur(v.uv - shift, vec2(0.0, 1.0), sigma).b;
  return vec4(r, g.g, b, g.a);
}

// device-screen params: the surface (0 matte, 1 glossy), the screen's width and height (layer px).
// Glossy: a touch more contrast (its reflection is a layer of its own, device-reflection); matte: a faint haze that
// lifts the blacks, as an anti-glare coating does.
@fragment
fn fs_screen(v: VOut) -> @location(0) vec4<f32> {
  let c = textureSampleLevel(src, samp, v.uv, 0.0);
  let p = to_layer(v.uv) / vec2(param(1u), param(2u));
  let glossy = param(0u);
  let haze = vec3(0.035, 0.032, 0.03) * (1.0 - glossy);
  var rgb = c.rgb;
  rgb = mix(rgb, (rgb - 0.5 * c.a) * 1.05 + 0.5 * c.a, glossy);
  // The panel's backlight bleeding a little along its edges, so a dark picture still meets the black bezel at a line.
  let edge = min(min(p.x, 1.0 - p.x) * param(1u), min(p.y, 1.0 - p.y) * param(2u));
  let bleed = vec3(0.05, 0.06, 0.08) * exp(-max(edge, 0.0) / (0.002 * param(1u)));
  rgb = rgb + (haze + bleed) * (vec3(c.a) - rgb);
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

// device-reflection params: the screen in the plate's pixels (left, top, width, height), strength, the screen's corner
// radius (plate px), the blur's radius (plate px). The room behind the camera, kept to the screen and added as light
// (alpha 0 adds under premultiplied blending), as glass reflects.
@fragment
fn fs_reflection(v: VOut) -> @location(0) vec4<f32> {
  let p = to_layer(v.uv) - vec2(param(0u), param(1u));
  let half_size = vec2(param(2u), param(3u)) * 0.5;
  let r = param(5u);
  let q = abs(p - half_size) - half_size + r;
  let d = length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - r;
  let aa = max(fwidth(d), 1e-3);
  let inside = 1.0 - smoothstep(-aa, aa, d);
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
  return vec4(c.rgb * param(4u) * inside, 0.0);
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
