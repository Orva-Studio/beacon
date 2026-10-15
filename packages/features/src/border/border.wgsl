// params: thickness (target px), colour r, g, b, a (straight)
//
// The band is measured inward from the layer's own rounded edge, so it adds no
// size and follows Round Corners. Its outer edge is the layer mask's, so it is
// drawn over transparent content too.

@fragment
fn fs_border(v: VOut) -> @location(0) vec4<f32> {
  let o = textureSampleLevel(orig, samp, v.uv, 0.0);
  let px = 1.0 / max(frame.layer.z, 1e-4);
  let d = rounded_rect_sdf(to_layer(v.uv), frame.layer.xy, frame.radius) / px;
  let band = clamp(0.5 - d, 0.0, 1.0) - clamp(0.5 - (d + param(0u)), 0.0, 1.0);
  let a = param(4u) * band;
  return vec4(vec3(param(1u), param(2u), param(3u)) * a, a) + o * (1.0 - a);
}
