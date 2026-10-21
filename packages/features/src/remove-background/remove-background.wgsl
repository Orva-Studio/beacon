// remove-background-blur params: sigma (target px). The clip's own picture blurred behind the person: blurred with
// what is outside it counted out, so its edges keep their colour rather than fading to clear.
@fragment
fn fs_blur_h(v: VOut) -> @location(0) vec4<f32> {
  return gaussian(src, v.uv, vec2(1.0, 0.0), param(0u));
}

@fragment
fn fs_blur_v(v: VOut) -> @location(0) vec4<f32> {
  return gaussian(src, v.uv, vec2(0.0, 1.0), param(0u));
}

@fragment
fn fs_fill(v: VOut) -> @location(0) vec4<f32> {
  let c = textureSampleLevel(src, samp, v.uv, 0.0);
  let a = textureSampleLevel(orig, samp, v.uv, 0.0).a;
  return vec4(c.rgb / max(c.a, 1e-4) * a, a);
}
