// Built-in drawing: layers onto canvas-size textures, compositing, mipmaps
// and masked backdrops. Every texture holds premultiplied alpha (stills are
// premultiplied on upload; video is opaque).

struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) local: vec2<f32>,
  @location(1) uv: vec2<f32>,
};

// Coverage from a signed distance in local pixels, antialiased over one
// target pixel whatever the layer's scale.
fn coverage(d: f32) -> f32 {
  let w = max(fwidth(d), 1e-4);
  return clamp(0.5 - d / w, 0.0, 1.0);
}

// ---- layer draw ----

struct Draw {
  m0: vec4<f32>,      // a, b, c, d
  m1: vec4<f32>,      // e, f, target width, target height
  rect: vec4<f32>,    // crop left, crop top, layer width, layer height
  content: vec4<f32>, // content width, content height, weight, w: the matte's clear brightness
  radius: vec4<f32>,
  color: vec4<f32>,   // multiplies the sample (solid colour, or white)
  margin: vec4<f32>,  // x: quad expansion in layer pixels for edge antialiasing; yz: perspective row (g, h); w: the matte's opaque brightness
};
@group(0) @binding(0) var<uniform> draw: Draw;
@group(0) @binding(1) var draw_tex: texture_2d<f32>;
@group(0) @binding(2) var draw_samp: sampler;

@vertex
fn vs_draw(@builtin(vertex_index) i: u32) -> VOut {
  let corners = array<vec2<f32>, 6>(
    vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(0.0, 1.0),
    vec2(0.0, 1.0), vec2(1.0, 0.0), vec2(1.0, 1.0));
  let m = draw.margin.x;
  let local = corners[i] * (draw.rect.zw + vec2(2.0 * m)) - vec2(m);
  let t = vec2(
    draw.m0.x * local.x + draw.m0.z * local.y + draw.m1.x,
    draw.m0.y * local.x + draw.m0.w * local.y + draw.m1.y);
  // Homogeneous: the GPU divides by w, so `local` and `uv` interpolate perspective-correct.
  let w = draw.margin.y * local.x + draw.margin.z * local.y + 1.0;
  var o: VOut;
  o.pos = vec4(t.x / draw.m1.z * 2.0 - w, w - t.y / draw.m1.w * 2.0, 0.0, w);
  o.local = local;
  o.uv = (local + draw.rect.xy) / draw.content.xy;
  return o;
}

fn drawn(v: VOut) -> vec4<f32> {
  let d = rounded_rect_sdf(v.local, draw.rect.zw, draw.radius);
  let cov = coverage(d);
  // Half a mip level sharper than trilinear: downscaled text stays crisp.
  let c = textureSampleBias(draw_tex, draw_samp, clamp(v.uv, vec2(0.0), vec2(1.0)), -0.5) * draw.color;
  return c * cov * draw.content.z;
}

@fragment
fn fs_draw(v: VOut) -> @location(0) vec4<f32> {
  return drawn(v);
}

// The layer's matte, at the same content point: its brightness from content.w (clear) to margin.w (opaque).
@group(0) @binding(3) var draw_matte: texture_2d<f32>;

@fragment
fn fs_draw_matte(v: VOut) -> @location(0) vec4<f32> {
  let m = textureSampleLevel(draw_matte, draw_samp, clamp(v.uv, vec2(0.0), vec2(1.0)), 0.0).r;
  return drawn(v) * clamp((m - draw.content.w) / max(draw.margin.w - draw.content.w, 1e-4), 0.0, 1.0);
}

// ---- fullscreen helpers ----

@vertex
fn vs_full(@builtin(vertex_index) i: u32) -> VOut {
  let p = fullscreen(i);
  var o: VOut;
  o.pos = vec4(p, 0.0, 1.0);
  o.uv = fullscreen_uv(p);
  o.local = vec2(0.0);
  return o;
}

struct Composite { opacity: vec4<f32> };
@group(0) @binding(0) var<uniform> comp: Composite;
@group(0) @binding(1) var comp_tex: texture_2d<f32>;
@group(0) @binding(2) var comp_samp: sampler;

@fragment
fn fs_composite(v: VOut) -> @location(0) vec4<f32> {
  return textureSampleLevel(comp_tex, comp_samp, v.uv, 0.0) * comp.opacity.x;
}

// A source mip level from the level above (bound as comp_tex).
@fragment
fn fs_mip(v: VOut) -> @location(0) vec4<f32> {
  return textureSampleLevel(comp_tex, comp_samp, v.uv, 0.0);
}

// ---- backdrop: processed copy of the target, drawn back through a mask ----

struct Mask {
  inv0: vec4<f32>,   // target → layer: a, b, c, d
  inv1: vec4<f32>,   // e, f, target width, target height
  size: vec4<f32>,   // layer width, height, invert, unused
  radius: vec4<f32>,
};
@group(0) @binding(0) var<uniform> mask: Mask;
@group(0) @binding(1) var mask_tex: texture_2d<f32>;
@group(0) @binding(2) var mask_samp: sampler;

@fragment
fn fs_mask(v: VOut) -> @location(0) vec4<f32> {
  let p = v.uv * mask.inv1.zw;
  let local = vec2(
    mask.inv0.x * p.x + mask.inv0.z * p.y + mask.inv1.x,
    mask.inv0.y * p.x + mask.inv0.w * p.y + mask.inv1.y);
  var cov = coverage(rounded_rect_sdf(local, mask.size.xy, mask.radius));
  if (mask.size.z > 0.5) {
    cov = 1.0 - cov;
  }
  return textureSampleLevel(mask_tex, mask_samp, v.uv, 0.0) * cov * mask.size.w;
}
