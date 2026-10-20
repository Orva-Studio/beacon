// Film Look, ported from hance's colour settings, halation, grain and vignette passes (docs/shared-candidates.md).
// params: 0 strength, 1 white balance (K), 2 fade, 3 contrast, 4 saturation, 5 exposure, 6 grain (0-1),
// 7 grain size, 8 halation, 9 halation size (px at 1080 high), 10 vignette, 11 frame (grain's seed), 12 tint,
// 13-15 split tone's shadow shift (rgb), 16-18 its highlight shift, 19 its midtone red

const LUMA = vec3(0.2126, 0.7152, 0.0722);
// hance's render constants (core/constants/render.json).
const HALATION_THRESHOLD = vec2(0.65, 0.75);
const HALATION_CHANNEL_SIGMA = vec3(1.0, 0.62, 0.38);
const HALATION_PSF = vec4(1.0, 0.7, 2.6, 0.3);
const REFERENCE_HEIGHT = 1080.0;
const GRAIN_SATURATION = 0.3;

fn to_linear(c: vec3<f32>) -> vec3<f32> {
  return select(pow((c + 0.055) / 1.055, vec3(2.4)), c / 12.92, c <= vec3(0.04045));
}

fn to_srgb(c: vec3<f32>) -> vec3<f32> {
  let l = max(c, vec3(0.0));
  return select(1.055 * pow(l, vec3(1.0 / 2.4)) - 0.055, l * 12.92, l <= vec3(0.0031308));
}

fn straight(c: vec4<f32>) -> vec3<f32> {
  return select(vec3(0.0), c.rgb / c.a, c.a > 1e-5);
}

fn white_balance(color: vec3<f32>, kelvin: f32) -> vec3<f32> {
  if (abs(kelvin - 6500.0) < 1.0) {
    return color;
  }
  let t = kelvin / 100.0;
  var r = 1.0;
  var g: f32;
  var b: f32;
  if (t <= 66.0) {
    g = clamp(0.39008 * log(t) - 0.63184, 0.0, 1.0);
  } else {
    r = clamp(1.292936 * pow(t - 60.0, -0.1332047592), 0.0, 1.0);
    g = clamp(1.129891 * pow(t - 60.0, -0.0755148492), 0.0, 1.0);
  }
  if (t >= 66.0) {
    b = 1.0;
  } else if (t <= 19.0) {
    b = 0.0;
  } else {
    b = clamp(0.54320 * log(t - 10.0) - 1.19625, 0.0, 1.0);
  }
  return color * vec3(r, g, b) / vec3(1.0, 0.9468, 0.9228);
}

/// hance's colour settings, in sRGB: exposure, contrast, fade (lifted blacks, flatter contrast), saturation, white balance, tint.
fn grade(color: vec3<f32>) -> vec3<f32> {
  let fade = param(2u);
  var c = (color - 0.5) * param(3u) * (1.0 - fade) + 0.5 + param(5u) * 0.1;
  c = clamp(c + vec3(fade * 0.05), vec3(0.0), vec3(1.0));
  c = mix(vec3(dot(c, LUMA)), c, param(4u));
  c = white_balance(c, param(1u));
  c.g += param(12u) * 0.1;
  return clamp(c, vec3(0.0), vec3(1.0));
}

/// hance's split tone (GIMP's colour balance): a channel shifted by how much of it is shadow, midtone and highlight.
fn balance(v: f32, lightness: f32, shadows: f32, midtones: f32, highlights: f32) -> f32 {
  let a = 4.0;
  let b = 0.333;
  let scale = 0.7;
  let shadow = clamp((b - lightness) * a + 0.5, 0.0, 1.0) * scale;
  let mid = clamp((lightness - b) * a + 0.5, 0.0, 1.0) * clamp((1.0 - lightness - b) * a + 0.5, 0.0, 1.0) * scale;
  let highlight = clamp((lightness + b - 1.0) * a + 0.5, 0.0, 1.0) * scale;
  return clamp(v + shadows * shadow + midtones * mid + highlights * highlight, 0.0, 1.0);
}

fn split_tone(c: vec3<f32>) -> vec3<f32> {
  let lightness = max(max(c.r, c.g), c.b) + min(min(c.r, c.g), c.b);
  return vec3(
    balance(c.r, lightness, param(13u), param(19u), param(16u)),
    balance(c.g, lightness, param(14u), 0.0, param(17u)),
    balance(c.b, lightness, param(15u), 0.0, param(18u)),
  );
}

fn highlights(c: vec3<f32>) -> vec3<f32> {
  return c * smoothstep(HALATION_THRESHOLD.x, HALATION_THRESHOLD.y, max(max(c.r, c.g), c.b));
}

@fragment
fn fs_highlights(v: VOut) -> @location(0) vec4<f32> {
  let c = textureSampleLevel(orig, samp, v.uv, 0.0);
  return vec4(highlights(to_linear(grade(straight(c)))) * c.a, 1.0);
}

fn psf(i: f32, s: f32) -> f32 {
  let a = max(s * HALATION_PSF.x, 0.001);
  let b = max(s * HALATION_PSF.z, 0.001);
  return HALATION_PSF.y * exp(-(i * i) / (2.0 * a * a)) + HALATION_PSF.w * exp(-(i * i) / (2.0 * b * b));
}

/// Per-channel scatter: red spreads widest, blue least, each a sharp core and a long tail.
fn scatter(uv: vec2<f32>, dir: vec2<f32>) -> vec4<f32> {
  let sigma = max(HALATION_CHANNEL_SIGMA * param(9u) * target_size().y / REFERENCE_HEIGHT, vec3(0.001));
  if (param(8u) <= 0.0 || sigma.x < 0.05) {
    return textureSampleLevel(src, samp, uv, 0.0);
  }
  let px = dir / target_size();
  // At most 40 taps a side: wide halos are sampled further apart, the sampler filtering between texels.
  let reach = sigma.x * HALATION_PSF.z * 3.0;
  let stride = max(1.0, reach / 40.0);
  let n = i32(ceil(reach / stride));
  var acc = vec3(0.0);
  var wsum = vec3(0.0);
  for (var k = -n; k <= n; k++) {
    let i = f32(k) * stride;
    let w = vec3(psf(i, sigma.x), psf(i, sigma.y), psf(i, sigma.z));
    acc += textureSampleLevel(src, samp, uv + px * i, 0.0).rgb * w;
    wsum += w;
  }
  return vec4(acc / wsum, 1.0);
}

@fragment
fn fs_scatter_h(v: VOut) -> @location(0) vec4<f32> {
  return scatter(v.uv, vec2(1.0, 0.0));
}

@fragment
fn fs_scatter_v(v: VOut) -> @location(0) vec4<f32> {
  return scatter(v.uv, vec2(0.0, 1.0));
}

fn hash(p: vec2<f32>) -> f32 {
  var p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

fn octave(coord: vec2<f32>) -> vec3<f32> {
  let r = hash(coord) * 2.0 - 1.0;
  let g = hash(coord + vec2(1.7, 3.1)) * 2.0 - 1.0;
  let b = hash(coord + vec2(5.3, 2.9)) * 2.0 - 1.0;
  return mix(vec3((r + g + b) / 3.0), vec3(r, g, b), GRAIN_SATURATION);
}

/// Three octaves of noise, reseeded each frame so the grain boils in place.
fn grain_noise(p: vec2<f32>, t: f32) -> vec3<f32> {
  let scale = 1.0 / (1.0 + param(7u));
  var sum = vec3(0.0);
  var amp = 1.0;
  var freq = 1.0;
  var norm = 0.0;
  for (var i = 0; i < 3; i++) {
    let coord = floor(p * scale * freq) + vec2(t * 71.7, t * 47.3) + f32(i) * 19.0;
    sum += octave(coord) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2.0;
  }
  return sum / norm;
}

@fragment
fn fs_look(v: VOut) -> @location(0) vec4<f32> {
  let o = textureSampleLevel(orig, samp, v.uv, 0.0);
  let before = straight(o);
  // Halation, grain and vignette in linear light, as hance's light-transport passes.
  var c = to_linear(grade(before));
  // Halation: the scattered highlights less their own core (a ring, not a filled disc), added within the headroom.
  let ring = max(textureSampleLevel(src, samp, v.uv, 0.0).rgb / max(o.a, 1e-5) - highlights(c), vec3(0.0));
  c = c + param(8u) * ring * max(vec3(1.0) - c, vec3(0.0));
  // Grain in shadows more than highlights, as an overlay.
  let n = grain_noise(v.uv * target_size(), param(11u)) * mix(1.0, 0.35, sqrt(clamp(dot(c, LUMA), 0.0, 1.0)));
  let overlay = select(2.0 * c * (0.5 + n * 0.5), 1.0 - 2.0 * (1.0 - c) * (0.5 - n * 0.5), c > vec3(0.5));
  c = mix(c, overlay, clamp(param(6u), 0.0, 1.0));
  // Vignette over the clip's own frame.
  let p = to_layer(v.uv) / frame.layer.xy - 0.5;
  let vig = cos(min(length(vec2(p.x, p.y * 0.875)) * 2.0 * param(10u) * 1.5707963, 1.5707963));
  c = c * vig * vig;
  var after = clamp(to_srgb(c), vec3(0.0), vec3(1.0));
  if (param(19u) != 0.0) {
    after = split_tone(after);
  }
  return vec4(mix(before, after, param(0u)) * o.a, o.a);
}
