// params: dx, dy, sigma (target pixels), colour r, g, b, a (straight)

@fragment
fn fs_mask(v: VOut) -> @location(0) vec4<f32> {
  let offset = vec2(param(0u), param(1u)) / target_size();
  let a = textureSampleLevel(orig, samp, v.uv - offset, 0.0).a;
  let c = vec4(param(3u), param(4u), param(5u), 1.0) * param(6u);
  return c * a;
}

@fragment
fn fs_blur_h(v: VOut) -> @location(0) vec4<f32> {
  return gaussian(src, v.uv, vec2(1.0, 0.0), param(2u));
}

@fragment
fn fs_blur_v(v: VOut) -> @location(0) vec4<f32> {
  return gaussian(src, v.uv, vec2(0.0, 1.0), param(2u));
}

@fragment
fn fs_combine(v: VOut) -> @location(0) vec4<f32> {
  let top = textureSampleLevel(orig, samp, v.uv, 0.0);
  let shadow = textureSampleLevel(src, samp, v.uv, 0.0);
  return top + shadow * (1.0 - top.a);
}
