// device-frame params (canvas pixels unless said):
//  0-8   frame pixel → screen point, a 3×3 homography (row-major)
//  9-11  the screen point's depth: z = p9·x + p10·y + p11
//  12    the depth in focus
//  13    aperture: the blur, in canvas px, of a point twice as far as the focus
//  14    the room's depth
//  15-18 the bezel's edges around the screen: left, top, right, bottom
//  19    the screen's width, 20 its height; 29-30 its top-left corner (the recording's place on the canvas)
//  21    the largest blur (sigma)
//  22    glow strength, 23 glow threshold (0–1), 24 glow size (sigma)
//  25    chromatic aberration at the frame's corners
//  26-27 the focus point on the screen, 28 how far from it the screen stays sharp (screen px)

fn df_screen_point(uv: vec2<f32>) -> vec2<f32> {
  let p = to_layer(uv);
  let w = param(6u) * p.x + param(7u) * p.y + param(8u);
  return vec2(param(0u) * p.x + param(1u) * p.y + param(2u), param(3u) * p.x + param(4u) * p.y + param(5u)) / w;
}

// The blur (sigma, target px) where the frame shows `uv`: on the monitor by its depth there, else the room's.
fn df_sigma(uv: vec2<f32>) -> f32 {
  let s = df_screen_point(uv);
  let o = vec2(param(29u), param(30u));
  let inside = s.x > o.x - param(15u) && s.y > o.y - param(16u) && s.x < o.x + param(19u) + param(17u) && s.y < o.y + param(20u) + param(18u);
  var z = param(14u);
  var falloff = 0.0;
  if (inside) {
    z = param(9u) * s.x + param(10u) * s.y + param(11u);
    // Head on, the screen is all one distance away, so optics alone would keep it all sharp: the screen softens with
    // distance from the focus (the cursor) instead, the look the user asked for.
    let d = distance(s, vec2(param(26u), param(27u)));
    falloff = param(13u) * 0.3 * smoothstep(param(28u), param(28u) * 3.0, d);
  }
  let coc = max(param(13u) * abs(z - param(12u)) / max(z, 1.0), falloff);
  return min(coc, param(21u)) * frame.layer.z;
}

// Only the screen glows: the room's lamps and bokeh blooming as well made the room look hazy (the user, 2026-11-04).
fn df_bright(c: vec4<f32>, uv: vec2<f32>) -> vec4<f32> {
  let s = df_screen_point(uv);
  let o = vec2(param(29u), param(30u));
  if (s.x < o.x || s.y < o.y || s.x > o.x + param(19u) || s.y > o.y + param(20u)) {
    return vec4(0.0);
  }
  let l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
  let k = smoothstep(param(23u), min(param(23u) + 0.25, 1.0), l);
  return vec4(c.rgb * k, c.a * k);
}

// A Gaussian over the bright parts only, as hance's bloom spreads them.
@fragment
fn fs_glow_h(v: VOut) -> @location(0) vec4<f32> {
  let sigma = param(24u) * frame.layer.z;
  if (sigma < 0.01) {
    return vec4(0.0);
  }
  let px = vec2(1.0, 0.0) / target_size() * max(1.0, sigma / 8.0);
  let n = 24;
  let step_sigma = sigma / max(1.0, sigma / 8.0);
  var acc = vec4(0.0);
  var wsum = 0.0;
  for (var k = -n; k <= n; k++) {
    let w = exp(-f32(k * k) / (2.0 * step_sigma * step_sigma));
    acc += df_bright(textureSampleLevel(orig, samp, v.uv + px * f32(k), 0.0), v.uv + px * f32(k)) * w;
    wsum += w;
  }
  return acc / wsum;
}

@fragment
fn fs_glow_v(v: VOut) -> @location(0) vec4<f32> {
  let sigma = param(24u) * frame.layer.z;
  if (sigma < 0.01) {
    return vec4(0.0);
  }
  let scale = max(1.0, sigma / 8.0);
  let px = vec2(0.0, 1.0) / target_size() * scale;
  let n = 24;
  let step_sigma = sigma / scale;
  var acc = vec4(0.0);
  var wsum = 0.0;
  for (var k = -n; k <= n; k++) {
    let w = exp(-f32(k * k) / (2.0 * step_sigma * step_sigma));
    acc += textureSampleLevel(src, samp, v.uv + px * f32(k), 0.0) * w;
    wsum += w;
  }
  return acc / wsum;
}

// Screen blend of the glow over the picture: light adds, nothing goes past white.
@fragment
fn fs_glow_add(v: VOut) -> @location(0) vec4<f32> {
  let base = textureSampleLevel(orig, samp, v.uv, 0.0);
  let glow = textureSampleLevel(src, samp, v.uv, 0.0).rgb * param(22u);
  return vec4(base.rgb + glow * (vec3(base.a) - base.rgb), base.a);
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
  var acc = vec4(0.0);
  var wsum = 0.0;
  for (var k = -n; k <= n; k++) {
    let w = exp(-f32(k * k) / (2.0 * s * s));
    acc += textureSampleLevel(src, samp, uv + px * f32(k), 0.0) * w;
    wsum += w;
  }
  return acc / wsum;
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

// device-screen params: the surface (0 matte, 1 glossy), the screen's width and height (layer px), where the sheen's
// band crosses (moves with the camera).
// Glossy: a soft diagonal sheen from the room's light and a touch more contrast; matte: a faint haze that lifts the
// blacks, as an anti-glare coating does.
@fragment
fn fs_screen(v: VOut) -> @location(0) vec4<f32> {
  let c = textureSampleLevel(src, samp, v.uv, 0.0);
  let p = to_layer(v.uv) / vec2(param(1u), param(2u));
  let glossy = param(0u);
  let band = exp(-pow((p.x * 0.8 + p.y * 0.6 - param(3u)) / 0.22, 2.0));
  let sheen = vec3(1.0, 0.93, 0.85) * (0.02 + 0.09 * band) * glossy;
  let haze = vec3(0.035, 0.032, 0.03) * (1.0 - glossy);
  var rgb = c.rgb;
  rgb = mix(rgb, (rgb - 0.5 * c.a) * 1.05 + 0.5 * c.a, glossy);
  let spot = vec2(0.72 - (param(3u) - 0.35) * 0.5, 0.22);
  let r = (p - spot) * vec2(1.0, 1.8);
  let lamp = vec3(1.0, 0.78, 0.52) * 0.09 * exp(-dot(r, r) / 0.02) * glossy;
  // The panel's backlight bleeding a little along its edges, so a dark picture still meets the black bezel at a line.
  let edge = min(min(p.x, 1.0 - p.x) * param(1u), min(p.y, 1.0 - p.y) * param(2u));
  let bleed = vec3(0.05, 0.06, 0.08) * exp(-max(edge, 0.0) / (0.002 * param(1u)));
  rgb = rgb + (sheen + haze + lamp + bleed) * (vec3(c.a) - rgb);
  return vec4(clamp(rgb, vec3(0.0), vec3(c.a)), c.a);
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
