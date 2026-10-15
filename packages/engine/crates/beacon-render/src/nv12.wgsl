// The canvas (premultiplied RGBA) as BT.709 video-range NV12 for the encoder: luma at the video's size, chroma
// at half, each the average of the canvas pixels it covers (the canvas fitted to the video's size).

struct Nv12 {
  // Canvas size, then canvas pixels per luma pixel.
  canvas: vec4<f32>,
};
@group(0) @binding(0) var<uniform> u: Nv12;
@group(0) @binding(1) var canvas: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

const KR: f32 = 0.2126;
const KB: f32 = 0.0722;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let p = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  return vec4(p[i], 0.0, 1.0);
}

// Straight RGB of the canvas pixels under target pixel `p`, `per` canvas pixels across it (as yuv.wgsl's area).
fn rgb(p: vec2<f32>, per: vec2<f32>) -> vec3<f32> {
  let n = max(vec2<i32>(1), vec2<i32>(ceil(per / 2.0 - 0.001)));
  let start = p * per;
  var sum = vec4(0.0);
  for (var j = 0; j < n.y; j++) {
    for (var i = 0; i < n.x; i++) {
      let at = start + (vec2(f32(i), f32(j)) + 0.5) * per / vec2<f32>(n);
      sum += textureSampleLevel(canvas, samp, at / u.canvas.xy, 0.0);
    }
  }
  let c = sum / f32(n.x * n.y);
  if (c.a <= 0.0) {
    return vec3(0.0);
  }
  return clamp(c.rgb / c.a, vec3(0.0), vec3(1.0));
}

fn luma(c: vec3<f32>) -> f32 {
  return KR * c.r + (1.0 - KR - KB) * c.g + KB * c.b;
}

@fragment
fn fs_luma(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
  let y = luma(rgb(floor(pos.xy), u.canvas.zw));
  return vec4((16.0 + 219.0 * y) / 255.0, 0.0, 0.0, 1.0);
}

@fragment
fn fs_chroma(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
  let c = rgb(floor(pos.xy), u.canvas.zw * 2.0);
  let y = luma(c);
  let cb = (c.b - y) / (2.0 * (1.0 - KB));
  let cr = (c.r - y) / (2.0 * (1.0 - KR));
  return vec4((128.0 + 224.0 * cb) / 255.0, (128.0 + 224.0 * cr) / 255.0, 0.0, 1.0);
}
