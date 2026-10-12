// region-blur params: sigma (target px)
@fragment
fn fs_blur_h(v: VOut) -> @location(0) vec4<f32> {
  return gaussian(src, v.uv, vec2(1.0, 0.0), param(0u));
}

@fragment
fn fs_blur_v(v: VOut) -> @location(0) vec4<f32> {
  return gaussian(src, v.uv, vec2(0.0, 1.0), param(0u));
}

// region-pixelate params: block size (target px)
@fragment
fn fs_pixelate(v: VOut) -> @location(0) vec4<f32> {
  let size = target_size();
  let block = max(param(0u), 1.0);
  let cell = (floor(v.uv * size / block) + 0.5) * block / size;
  return textureSampleLevel(src, samp, cell, 0.0);
}

// region-darken params: amount (0–1)
@fragment
fn fs_darken(v: VOut) -> @location(0) vec4<f32> {
  let c = textureSampleLevel(src, samp, v.uv, 0.0);
  return vec4(c.rgb * (1.0 - param(0u)), c.a);
}
