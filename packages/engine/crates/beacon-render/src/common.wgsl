// Prepended to every shader of Beacon's (render passes get prelude.wgsl after it).

// One triangle over the whole target: vertex `i`'s clip-space position.
fn fullscreen(i: u32) -> vec2<f32> {
  let p = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  return p[i];
}

// Target uv (0–1, y down) at clip-space position `p`.
fn fullscreen_uv(p: vec2<f32>) -> vec2<f32> {
  return vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
}

// Signed distance from `p` to a `size` box with corner radii top-left, top-right, bottom-right, bottom-left.
fn rounded_rect_sdf(p: vec2<f32>, size: vec2<f32>, radius: vec4<f32>) -> f32 {
  let c = p - size * 0.5;
  let r = select(radius.xw, radius.yz, c.x > 0.0);
  let rr = select(r.x, r.y, c.y > 0.0);
  let q = abs(c) - size * 0.5 + vec2(rr);
  return length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - rr;
}

// The mean of `t`'s pixels (`size` of them) under target pixel `p`, `per` of them across it: an area filter, as
// swscale's. Each bilinear tap halfway between two pixels averages them, so ceil(per / 2) taps an axis cover the
// span; one tap when the source is no larger.
fn area(t: texture_2d<f32>, s: sampler, p: vec2<f32>, size: vec2<f32>, per: vec2<f32>) -> vec4<f32> {
  let n = max(vec2<i32>(1), vec2<i32>(ceil(per / 2.0 - 0.001)));
  let start = p * per;
  var sum = vec4(0.0);
  for (var j = 0; j < n.y; j++) {
    for (var i = 0; i < n.x; i++) {
      let at = start + (vec2(f32(i), f32(j)) + 0.5) * per / vec2<f32>(n);
      sum += textureSampleLevel(t, s, at / size, 0.0);
    }
  }
  return sum / f32(n.x * n.y);
}
