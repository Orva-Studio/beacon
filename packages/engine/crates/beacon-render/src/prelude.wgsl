// Prepended to every render pass. A pass is a list of fragment entry points
// (steps) run in order over canvas-size premultiplied textures:
//   src  - the previous step's output (the pass input for the first step)
//   orig - the pass input, unchanged
// Each step writes a new texture; the last one replaces the layer.

struct PassFrame {
  inv0: vec4<f32>,   // target pixel → layer pixel: a, b, c, d
  inv1: vec4<f32>,   // e, f, target width, target height
  layer: vec4<f32>,  // layer width, height, scale (target px per layer px), step index
  radius: vec4<f32>, // the layer's corner radii in layer pixels
};
@group(0) @binding(0) var<uniform> frame: PassFrame;
struct PassParams { v: array<vec4<f32>, 8> };
@group(0) @binding(1) var<uniform> params: PassParams;
@group(0) @binding(2) var src: texture_2d<f32>;
@group(0) @binding(3) var orig: texture_2d<f32>;
@group(0) @binding(4) var samp: sampler;

struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs_full(@builtin(vertex_index) i: u32) -> VOut {
  let p = fullscreen(i);
  var o: VOut;
  o.pos = vec4(p, 0.0, 1.0);
  o.uv = fullscreen_uv(p);
  return o;
}

fn param(i: u32) -> f32 {
  return params.v[i / 4u][i % 4u];
}

fn target_size() -> vec2<f32> {
  return frame.inv1.zw;
}

/// Target uv (0–1) → layer pixel.
fn to_layer(uv: vec2<f32>) -> vec2<f32> {
  let p = uv * frame.inv1.zw;
  return vec2(
    frame.inv0.x * p.x + frame.inv0.z * p.y + frame.inv1.x,
    frame.inv0.y * p.x + frame.inv0.w * p.y + frame.inv1.y);
}

/// Separable Gaussian over `tex` along `dir` (in target pixels), sigma in target pixels.
fn gaussian(tex: texture_2d<f32>, uv: vec2<f32>, dir: vec2<f32>, sigma: f32) -> vec4<f32> {
  if (sigma < 0.01) {
    return textureSampleLevel(tex, samp, uv, 0.0);
  }
  let px = dir / target_size();
  let n = i32(ceil(sigma * 3.0));
  var acc = vec4(0.0);
  var wsum = 0.0;
  for (var k = -n; k <= n; k++) {
    let w = exp(-f32(k * k) / (2.0 * sigma * sigma));
    acc += textureSampleLevel(tex, samp, uv + px * f32(k), 0.0) * w;
    wsum += w;
  }
  return acc / wsum;
}

/// Layer pixel → target uv (0–1); the inverse of `to_layer`.
fn from_layer(p: vec2<f32>) -> vec2<f32> {
  let a = frame.inv0.x;
  let b = frame.inv0.y;
  let c = frame.inv0.z;
  let d = frame.inv0.w;
  let det = a * d - b * c;
  let q = p - frame.inv1.xy;
  let t = vec2(d * q.x - c * q.y, -b * q.x + a * q.y) / det;
  return t / frame.inv1.zw;
}
