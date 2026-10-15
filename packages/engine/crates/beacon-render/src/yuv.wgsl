// A video frame's NV12 planes, sampled where VideoToolbox decoded them, as RGBA at the decode size: each
// target pixel is the average of the source pixels it covers (an area filter, as swscale's), luma and chroma
// each at their own size, then converted with the stream's matrix and range.

struct Yuv {
  // Luma plane size, then source luma pixels per target pixel.
  luma: vec4<f32>,
  // Chroma plane size, then source chroma pixels per target pixel.
  chroma: vec4<f32>,
  // Kr, Kb, 1 for full range, unused.
  matrix: vec4<f32>,
};
@group(0) @binding(0) var<uniform> u: Yuv;
@group(0) @binding(1) var luma: texture_2d<f32>;
@group(0) @binding(2) var chroma: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let p = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  return vec4(p[i], 0.0, 1.0);
}

// The mean of the source pixels under target pixel `p`. Each bilinear tap halfway between two source pixels
// averages them, so ceil(span / 2) taps an axis cover the span; one tap when the source is no larger.
fn area(t: texture_2d<f32>, p: vec2<f32>, size: vec2<f32>, per: vec2<f32>) -> vec4<f32> {
  let n = max(vec2<i32>(1), vec2<i32>(ceil(per / 2.0 - 0.001)));
  let start = p * per;
  var sum = vec4(0.0);
  for (var j = 0; j < n.y; j++) {
    for (var i = 0; i < n.x; i++) {
      let at = start + (vec2(f32(i), f32(j)) + 0.5) * per / vec2<f32>(n);
      sum += textureSampleLevel(t, samp, at / size, 0.0);
    }
  }
  return sum / f32(n.x * n.y);
}

@fragment
fn fs(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
  let p = floor(pos.xy);
  var y = area(luma, p, u.luma.xy, u.luma.zw).r;
  var c = area(chroma, p, u.chroma.xy, u.chroma.zw).rg - vec2(128.0 / 255.0);
  if (u.matrix.z < 0.5) {
    y = (y - 16.0 / 255.0) * (255.0 / 219.0);
    c = c * (255.0 / 224.0);
  }
  let kr = u.matrix.x;
  let kb = u.matrix.y;
  let kg = 1.0 - kr - kb;
  let r = y + 2.0 * (1.0 - kr) * c.y;
  let b = y + 2.0 * (1.0 - kb) * c.x;
  let g = y - (2.0 * kb * (1.0 - kb) * c.x + 2.0 * kr * (1.0 - kr) * c.y) / kg;
  return vec4(clamp(vec3(r, g, b), vec3(0.0), vec3(1.0)), 1.0);
}
