//! The live preview: the export renderer drawing the canvas at full size,
//! then fitted into a native view's `CAMetalLayer` (or an offscreen target
//! for parity tests). Preview and export share every pixel up to the fit.

use std::ffi::c_void;

use crate::render::{FMT, instance, rt_usage, tex_desc};
use crate::scene::{Job, Scene};
use crate::{Error, Renderer, Result};

/// Where the canvas sits in the view: canvas pixels per view pixel and the
/// canvas centre's offset from the view centre, in view pixels.
#[derive(Debug, Clone, Copy, serde::Deserialize)]
pub struct Placement {
    pub zoom: f32,
    pub pan: [f32; 2],
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct FitUniform {
    /// view px → canvas uv: uv = px * scale + offset
    scale: [f32; 2],
    offset: [f32; 2],
    /// canvas texels per view pixel, for the box filter
    footprint: [f32; 2],
    taps: [f32; 2],
    surround: [f32; 4],
}

/// Drawn over the fitted canvas in the same frame: the editor's selection,
/// handles and snap guides. Positions are canvas pixels (y down), placed with
/// the picture so they never lag it while panning or zooming; widths and
/// radii are view pixels. Colours are straight RGBA in 0..1.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Mark {
    /// `butt`: square ends at `from` and `to` (a filled band, such as a text selection) instead of round caps.
    Line { from: [f32; 2], to: [f32; 2], width: f32, color: [f32; 4], #[serde(default)] butt: bool },
    Circle { at: [f32; 2], radius: f32, width: f32, fill: [f32; 4], stroke: [f32; 4] },
}

/// One mark as the marks shader reads it: `shape` = kind (0 line, 1 circle), width, radius.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct MarkInstance {
    shape: [f32; 4],
    points: [f32; 4],
    fill: [f32; 4],
    stroke: [f32; 4],
}

impl From<&Mark> for MarkInstance {
    fn from(m: &Mark) -> Self {
        match *m {
            Mark::Line { from, to, width, color, butt } => Self { shape: [0.0, width, 0.0, if butt { 1.0 } else { 0.0 }], points: [from[0], from[1], to[0], to[1]], fill: [0.0; 4], stroke: color },
            Mark::Circle { at, radius, width, fill, stroke } => Self { shape: [1.0, width, radius, 0.0], points: [at[0], at[1], at[0], at[1]], fill, stroke },
        }
    }
}

const MARKS_WGSL: &str = r#"
@group(0) @binding(0) var<uniform> view: vec4<f32>;

struct Mark { @location(0) shape: vec4<f32>, @location(1) points: vec4<f32>, @location(2) fill: vec4<f32>, @location(3) stroke: vec4<f32> };
struct Out { @builtin(position) pos: vec4<f32>, @location(0) px: vec2<f32>, @location(1) shape: vec4<f32>, @location(2) points: vec4<f32>, @location(3) fill: vec4<f32>, @location(4) stroke: vec4<f32> };

@vertex
fn vs(@builtin(vertex_index) i: u32, m: Mark) -> Out {
  // The mark's bounding box, a pixel wider for the antialiased edge.
  let pad = m.shape.y * 0.5 + m.shape.z + 1.5;
  let lo = min(m.points.xy, m.points.zw) - pad;
  let hi = max(m.points.xy, m.points.zw) + pad;
  let corner = array<vec2<f32>, 6>(vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(0.0, 1.0), vec2(0.0, 1.0), vec2(1.0, 0.0), vec2(1.0, 1.0))[i];
  let px = mix(lo, hi, corner);
  var o: Out;
  o.pos = vec4(px.x / view.x * 2.0 - 1.0, 1.0 - px.y / view.y * 2.0, 0.0, 1.0);
  o.px = px;
  o.shape = m.shape;
  o.points = m.points;
  o.fill = m.fill;
  o.stroke = m.stroke;
  return o;
}

fn over(top: vec4<f32>, under: vec4<f32>) -> vec4<f32> { return top + under * (1.0 - top.a); }

@fragment
fn fs(o: Out) -> @location(0) vec4<f32> {
  let half = o.shape.y * 0.5;
  if (o.shape.x < 0.5) {
    let a = o.points.xy;
    let ab = o.points.zw - a;
    let len = max(length(ab), 1e-6);
    let along = dot(o.px - a, ab) / len;
    let t = clamp(along / len, 0.0, 1.0);
    var d = length(o.px - (a + ab * t));
    var k = 1.0;
    if (o.shape.w > 0.5) {
      // Butt ends: distance across the line, cut at both ends.
      d = abs(dot(o.px - a, vec2(-ab.y, ab.x)) / len);
      k = clamp(min(along, len - along) + 0.5, 0.0, 1.0);
    }
    k = k * clamp(half + 0.5 - d, 0.0, 1.0) * o.stroke.a;
    return vec4(o.stroke.rgb * k, k);
  }
  let d = length(o.px - o.points.xy);
  let fk = clamp(o.shape.z - d + 0.5, 0.0, 1.0) * o.fill.a;
  let sk = clamp(half + 0.5 - abs(d - o.shape.z), 0.0, 1.0) * o.stroke.a;
  return over(vec4(o.stroke.rgb * sk, sk), vec4(o.fill.rgb * fk, fk));
}
"#;

enum Target {
    Surface { surface: wgpu::Surface<'static>, config: wgpu::SurfaceConfiguration, layer: usize },
    Offscreen(wgpu::Texture),
}

pub struct Preview {
    renderer: Renderer,
    target: Target,
    pipe: wgpu::RenderPipeline,
    bgl: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    pub surround: [f32; 4],
    marks_pipe: wgpu::RenderPipeline,
    marks_bgl: wgpu::BindGroupLayout,
    pub marks: Vec<Mark>,
}

const FIT_WGSL: &str = r#"
struct Fit { scale: vec2<f32>, offset: vec2<f32>, footprint: vec2<f32>, taps: vec2<f32>, surround: vec4<f32> };
@group(0) @binding(0) var<uniform> fit: Fit;
@group(0) @binding(1) var canvas: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let p = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  return vec4(p[i], 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
  let uv = pos.xy * fit.scale + fit.offset;
  if (any(uv < vec2(0.0)) || any(uv > vec2(1.0))) { return fit.surround; }
  // Box filter over the view pixel's footprint: the canvas is usually drawn smaller than its size.
  var acc = vec4(0.0);
  let n = fit.taps;
  for (var y = 0.0; y < n.y; y += 1.0) {
    for (var x = 0.0; x < n.x; x += 1.0) {
      let d = (vec2(x, y) + 0.5) / n - 0.5;
      acc += textureSampleLevel(canvas, samp, uv + d * fit.footprint, 0.0);
    }
  }
  let c = acc / (n.x * n.y);
  // Premultiplied canvas over the surround colour.
  return vec4(c.rgb + fit.surround.rgb * (1.0 - c.a), 1.0);
}
"#;

impl Preview {
    /// # Safety
    /// `layer` must be a live `CAMetalLayer` that outlives the preview.
    pub unsafe fn on_layer(job: &Job, layer: *mut c_void, width: u32, height: u32) -> Result<Self> {
        let instance = instance();
        let surface = unsafe { instance.create_surface_unsafe(wgpu::SurfaceTargetUnsafe::CoreAnimationLayer(layer)) }.map_err(|e| Error::Gpu(format!("surface: {e}")))?;
        let renderer = Renderer::with_instance(job, &instance, Some(&surface))?;
        let caps = surface.get_capabilities(renderer.adapter());
        // A non-sRGB format shows the canvas bytes as they are, like the exported video.
        let format = [wgpu::TextureFormat::Bgra8Unorm, wgpu::TextureFormat::Rgba8Unorm]
            .into_iter()
            .find(|f| caps.formats.contains(f))
            .or_else(|| caps.formats.first().copied())
            .ok_or_else(|| Error::Gpu("surface has no formats".into()))?;
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            width: width.max(1),
            height: height.max(1),
            present_mode: wgpu::PresentMode::Fifo,
            desired_maximum_frame_latency: 2,
            alpha_mode: wgpu::CompositeAlphaMode::Opaque,
            view_formats: vec![],
            color_space: wgpu::SurfaceColorSpace::Auto,
        };
        surface.configure(renderer.device(), &config);
        tag_srgb(layer as usize);
        flush_transaction();
        Ok(Self::build(renderer, Target::Surface { surface, config, layer: layer as usize }, format))
    }

    /// Draws into a texture instead of a view, for comparing with export.
    pub fn offscreen(job: &Job, width: u32, height: u32) -> Result<Self> {
        let renderer = Renderer::new(job)?;
        let tex = renderer.device().create_texture(&tex_desc(width.max(1), height.max(1), 1, rt_usage()));
        Ok(Self::build(renderer, Target::Offscreen(tex), FMT))
    }

    fn build(mut renderer: Renderer, target: Target, format: wgpu::TextureFormat) -> Self {
        renderer.lenient_sources = true;
        let device = renderer.device();
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("fit"), source: wgpu::ShaderSource::Wgsl(FIT_WGSL.into()) });
        let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("fit"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry { binding: 2, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None },
            ],
        });
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: None, bind_group_layouts: &[Some(&bgl)], immediate_size: 0 });
        let pipe = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("fit"),
            layout: Some(&layout),
            vertex: wgpu::VertexState { module: &module, entry_point: Some("vs"), buffers: &[], compilation_options: Default::default() },
            fragment: Some(wgpu::FragmentState {
                module: &module,
                entry_point: Some("fs"),
                targets: &[Some(wgpu::ColorTargetState { format, blend: None, write_mask: wgpu::ColorWrites::ALL })],
                compilation_options: Default::default(),
            }),
            primitive: Default::default(),
            depth_stencil: None,
            multisample: Default::default(),
            multiview_mask: None,
            cache: None,
        });
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            ..Default::default()
        });
        let marks_module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("marks"), source: wgpu::ShaderSource::Wgsl(MARKS_WGSL.into()) });
        let marks_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("marks"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX,
                ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None },
                count: None,
            }],
        });
        let marks_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: None, bind_group_layouts: &[Some(&marks_bgl)], immediate_size: 0 });
        let attrs = wgpu::vertex_attr_array![0 => Float32x4, 1 => Float32x4, 2 => Float32x4, 3 => Float32x4];
        let marks_pipe = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("marks"),
            layout: Some(&marks_layout),
            vertex: wgpu::VertexState {
                module: &marks_module,
                entry_point: Some("vs"),
                buffers: &[Some(wgpu::VertexBufferLayout { array_stride: std::mem::size_of::<MarkInstance>() as u64, step_mode: wgpu::VertexStepMode::Instance, attributes: &attrs })],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &marks_module,
                entry_point: Some("fs"),
                targets: &[Some(wgpu::ColorTargetState { format, blend: Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING), write_mask: wgpu::ColorWrites::COLOR })],
                compilation_options: Default::default(),
            }),
            primitive: Default::default(),
            depth_stencil: None,
            multisample: Default::default(),
            multiview_mask: None,
            cache: None,
        });
        Self { renderer, target, pipe, bgl, sampler, surround: [0.0, 0.0, 0.0, 1.0], marks_pipe, marks_bgl, marks: Vec::new() }
    }

    pub fn size(&self) -> (u32, u32) {
        match &self.target {
            Target::Surface { config, .. } => (config.width, config.height),
            Target::Offscreen(t) => (t.width(), t.height()),
        }
    }

    pub fn resize(&mut self, width: u32, height: u32) {
        let (width, height) = (width.max(1), height.max(1));
        match &mut self.target {
            Target::Surface { surface, config, layer } => {
                config.width = width;
                config.height = height;
                surface.configure(self.renderer.device(), config);
                tag_srgb(*layer);
                flush_transaction();
            }
            Target::Offscreen(t) => *t = self.renderer.device().create_texture(&tex_desc(width, height, 1, rt_usage())),
        }
    }

    /// Canvas pixels per view pixel when the whole canvas fits the view.
    pub fn fit_zoom(&self) -> f32 {
        let (w, h) = self.size();
        (self.renderer.width as f32 / w as f32).max(self.renderer.height as f32 / h as f32)
    }

    fn uniform(&self, at: Placement) -> FitUniform {
        let (vw, vh) = self.size();
        let (cw, ch) = (self.renderer.width as f32, self.renderer.height as f32);
        let z = at.zoom.max(1e-4);
        // view px → canvas px: c = (p - view_centre - pan) * z + canvas_centre
        let scale = [z / cw, z / ch];
        let offset = [(-(vw as f32) / 2.0 - at.pan[0]) * z / cw + 0.5, (-(vh as f32) / 2.0 - at.pan[1]) * z / ch + 0.5];
        let taps = z.ceil().clamp(1.0, 4.0);
        FitUniform { scale, offset, footprint: [scale[0], scale[1]], taps: [taps, taps], surround: self.surround }
    }

    /// Follows the layer: its bounds change with the window and layout, and
    /// a drawable of another size would be stretched to fit them.
    fn follow_layer(&mut self) {
        if let Target::Surface { layer, config, .. } = &self.target {
            let (w, h) = layer_pixels(*layer);
            if (w, h) != (config.width, config.height) && w > 0 && h > 0 {
                self.resize(w, h);
            }
        }
    }

    /// Renders `scene` and shows it. Returns false when the surface had no
    /// frame to draw into (hidden or resizing); the next call retries.
    pub fn show(&mut self, scene: &Scene, at: Placement) -> Result<bool> {
        self.follow_layer();
        let enc = self.renderer.draw(scene)?;
        self.present(enc, at)
    }

    /// Shows the last drawn canvas again with a new placement, marks, surround
    /// or view size, without rendering the scene: panning, zooming and hovering
    /// cost a fit pass, not a frame. Call only after a `show`.
    pub fn recomposite(&mut self, at: Placement) -> Result<bool> {
        self.follow_layer();
        let enc = self.renderer.device().create_command_encoder(&Default::default());
        self.present(enc, at)
    }

    /// The fit pass and marks over the canvas texture, into the view.
    fn present(&mut self, mut enc: wgpu::CommandEncoder, at: Placement) -> Result<bool> {
        let uniform = self.uniform(at);
        let device = self.renderer.device();
        let buf = wgpu::util::DeviceExt::create_buffer_init(device, &wgpu::util::BufferInitDescriptor {
            label: None,
            contents: bytemuck::bytes_of(&uniform),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let canvas = self.renderer.output().create_view(&Default::default());
        let bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &self.bgl,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: buf.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&canvas) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(&self.sampler) },
            ],
        });
        let (vw, vh) = self.size();
        let (cw, ch) = (self.renderer.width as f32, self.renderer.height as f32);
        let z = at.zoom.max(1e-4);
        // canvas px → view px, the inverse of the fit pass's mapping.
        let place = |p: [f32; 2]| [(p[0] - cw / 2.0) / z + vw as f32 / 2.0 + at.pan[0], (p[1] - ch / 2.0) / z + vh as f32 / 2.0 + at.pan[1]];
        let marks: Vec<MarkInstance> = self
            .marks
            .iter()
            .map(|m| {
                let mut i = MarkInstance::from(m);
                let (a, b) = (place([i.points[0], i.points[1]]), place([i.points[2], i.points[3]]));
                i.points = [a[0], a[1], b[0], b[1]];
                i
            })
            .collect();
        let marks = (!marks.is_empty()).then(|| {
            let instances = wgpu::util::DeviceExt::create_buffer_init(device, &wgpu::util::BufferInitDescriptor { label: None, contents: bytemuck::cast_slice(&marks), usage: wgpu::BufferUsages::VERTEX });
            let size = wgpu::util::DeviceExt::create_buffer_init(device, &wgpu::util::BufferInitDescriptor {
                label: None,
                contents: bytemuck::cast_slice(&[vw as f32, vh as f32, 0.0, 0.0]),
                usage: wgpu::BufferUsages::UNIFORM,
            });
            let bg = device.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &self.marks_bgl, entries: &[wgpu::BindGroupEntry { binding: 0, resource: size.as_entire_binding() }] });
            (instances, bg, marks.len() as u32)
        });
        let (frame, view) = match &self.target {
            Target::Surface { surface, config, layer } => {
                let frame = match surface.get_current_texture() {
                    wgpu::CurrentSurfaceTexture::Success(f) | wgpu::CurrentSurfaceTexture::Suboptimal(f) => f,
                    wgpu::CurrentSurfaceTexture::Outdated | wgpu::CurrentSurfaceTexture::Lost => {
                        surface.configure(device, config);
                        tag_srgb(*layer);
                        self.renderer.queue().submit([enc.finish()]);
                        return Ok(false);
                    }
                    other => {
                        self.renderer.queue().submit([enc.finish()]);
                        return match other {
                            wgpu::CurrentSurfaceTexture::Timeout | wgpu::CurrentSurfaceTexture::Occluded => Ok(false),
                            e => Err(Error::Gpu(format!("surface: {e:?}"))),
                        };
                    }
                };
                let view = frame.texture.create_view(&Default::default());
                (Some(frame), view)
            }
            Target::Offscreen(t) => (None, t.create_view(&Default::default())),
        };
        {
            let mut rp = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("fit"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            rp.set_pipeline(&self.pipe);
            rp.set_bind_group(0, Some(&bg), &[]);
            rp.draw(0..3, 0..1);
            if let Some((instances, mbg, n)) = &marks {
                rp.set_pipeline(&self.marks_pipe);
                rp.set_bind_group(0, Some(mbg), &[]);
                rp.set_vertex_buffer(0, instances.slice(..));
                rp.draw(0..6, 0..*n);
            }
        }
        self.renderer.queue().submit([enc.finish()]);
        if let Some(f) = frame {
            self.renderer.queue().present(f);
            // Electrobun's layer presents inside Core Animation transactions,
            // which a thread without a run loop has to commit itself.
            flush_transaction();
        }
        Ok(true)
    }

    /// Straight-alpha RGBA of the last `show` (offscreen previews only).
    pub fn pixels(&mut self) -> Result<Vec<u8>> {
        let Target::Offscreen(t) = &self.target else { return Err(Error::Output("only offscreen previews can be read".into())) };
        let t = t.clone();
        let enc = self.renderer.device().create_command_encoder(&Default::default());
        Ok(self.renderer.read_pixels(enc, &t))
    }

    pub fn renderer(&mut self) -> &mut Renderer {
        &mut self.renderer
    }
}

#[repr(C)]
#[derive(Clone, Copy)]
struct CgRect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

unsafe impl objc2::Encode for CgRect {
    const ENCODING: objc2::Encoding = objc2::Encoding::Struct(
        "CGRect",
        &[
            objc2::Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]),
            objc2::Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]),
        ],
    );
}

/// A `CALayer`'s size in pixels: `bounds` × `contentsScale`. Reading them
/// off the main thread is safe (each is read atomically; wgpu does the same).
fn layer_pixels(layer: usize) -> (u32, u32) {
    let obj = layer as *const objc2::runtime::AnyObject;
    let (bounds, scale): (CgRect, f64) = unsafe { (objc2::msg_send![&*obj, bounds], objc2::msg_send![&*obj, contentsScale]) };
    ((bounds.w * scale).round() as u32, (bounds.h * scale).round() as u32)
}

#[repr(transparent)]
struct ColorSpaceRef(*mut c_void);

unsafe impl objc2::Encode for ColorSpaceRef {
    const ENCODING: objc2::Encoding = objc2::Encoding::Pointer(&objc2::Encoding::Struct("CGColorSpace", &[]));
}

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    static kCGColorSpaceSRGB: *const c_void;
    fn CGColorSpaceCreateWithName(name: *const c_void) -> *mut c_void;
    fn CGColorSpaceRelease(space: *mut c_void);
}

/// Tags the layer sRGB, as the canvas bytes are. wgpu's configure leaves it
/// untagged, and macOS then shows the bytes in the display's own gamut
/// (Display P3 on Apple screens): more saturated than the export plays.
fn tag_srgb(layer: usize) {
    let obj = layer as *const objc2::runtime::AnyObject;
    unsafe {
        let space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
        if space.is_null() {
            return;
        }
        let _: () = objc2::msg_send![&*obj, setColorspace: ColorSpaceRef(space)];
        CGColorSpaceRelease(space);
    }
}

/// Commits layer changes made on this thread: without a run loop here, the
/// implicit Core Animation transaction holding them would never commit.
fn flush_transaction() {
    let Some(class) = objc2::runtime::AnyClass::get(c"CATransaction") else { return };
    let _: () = unsafe { objc2::msg_send![class, flush] };
}
