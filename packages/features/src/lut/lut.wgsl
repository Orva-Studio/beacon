// lut params: 0 intensity, 1-3 the table's domain minimum (rgb), 4-6 its maximum. The clip's colours looked up in
// the `.cube` table (`lut`), between its entries trilinearly, and mixed with the originals by intensity.
@fragment
fn fs_lut(v: VOut) -> @location(0) vec4<f32> {
  let c = textureSampleLevel(src, samp, v.uv, 0.0);
  if (c.a < 1e-5) {
    return c;
  }
  let rgb = c.rgb / c.a;
  let lo = vec3(param(1u), param(2u), param(3u));
  let hi = vec3(param(4u), param(5u), param(6u));
  let n = f32(textureDimensions(lut).x);
  // Entry centres: 0 and 1 land on the first and last entries, not on the texture's edges.
  let at = clamp((rgb - lo) / max(hi - lo, vec3(1e-5)), vec3(0.0), vec3(1.0)) * (n - 1.0) / n + 0.5 / n;
  let graded = textureSampleLevel(lut, samp, at, 0.0).rgb;
  return vec4(mix(rgb, graded, param(0u)) * c.a, c.a);
}
