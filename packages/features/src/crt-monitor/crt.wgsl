// params: brightness, chromatic shift (target px), corner radius (layer px),
// scanline brightness, scanline spacing (layer px), vignette intensity,
// vignette shape, warp
//
// The warp moves points by 0.3 × Warp × r², the vignette is separable in x
// and y, and scanlines are a squared cosine (mean brightness 0.875 at ScanlineBrightness 0.8).
// ChromaticShift moves only the blue channel, upwards, ~0.5 px per unit.

@fragment
fn fs_crt(v: VOut) -> @location(0) vec4<f32> {
  let size = frame.layer.xy;
  let local = to_layer(v.uv);
  var c = local / size * 2.0 - 1.0;
  let warp = param(7u);
  c = c * (1.0 + 0.3 * warp * dot(c, c));
  let warped = (c * 0.5 + 0.5) * size;
  if (any(warped < vec2(0.0)) || any(warped > size)) {
    return vec4(0.0);
  }
  let d = rounded_rect_sdf(warped, size, vec4(param(2u)));
  let inside = clamp(0.5 - d, 0.0, 1.0);
  let uv = from_layer(warped);
  let shift = vec2(0.0, 0.5 * param(1u)) / target_size();
  let mid = textureSampleLevel(orig, samp, uv, 0.0);
  let b = textureSampleLevel(orig, samp, uv + shift, 0.0).b;
  var rgb = vec3(mid.r, mid.g, b);
  let spacing = max(param(4u), 1.0);
  let wave = 0.5 + 0.5 * cos(6.2831853 * warped.y / spacing);
  let line = wave * wave;
  rgb = rgb * mix(param(3u), 1.0, line);
  let edge = pow(min(abs(c), vec2(1.0)), vec2(param(6u)));
  let vig = (1.0 - param(5u) * edge.x) * (1.0 - param(5u) * edge.y);
  rgb = rgb * clamp(vig, 0.0, 1.0) * param(0u);
  return vec4(rgb, mid.a) * inside;
}
