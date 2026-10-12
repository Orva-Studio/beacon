use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use wgpu::util::DeviceExt;

use crate::scene::{Affine, Backdrop, Content, Job, Layer, PassUse, Scene, Source, Visual};
use crate::sources::{self, VideoDecoder};
use crate::{Error, Result};

pub(crate) const FMT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;
const MAX_PARAMS: usize = 32;

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct DrawU {
    m0: [f32; 4],
    m1: [f32; 4],
    rect: [f32; 4],
    content: [f32; 4],
    radius: [f32; 4],
    color: [f32; 4],
    margin: [f32; 4],
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct PassFrameU {
    inv0: [f32; 4],
    inv1: [f32; 4],
    layer: [f32; 4],
    radius: [f32; 4],
}

struct SourceTex {
    tex: wgpu::Texture,
    width: u32,
    height: u32,
    decoder: Option<VideoDecoder>,
    /// The decoder for the other of proxy and original, kept so settling on a
    /// frame and moving again don't restart ffmpeg (or re-decode the frame shown).
    spare: Option<VideoDecoder>,
    last_used: u64,
}

/// Frames a source texture (and its decoder) is kept after its last use, so
/// brief gaps between clips of one recording don't restart its decoder.
const KEEP_FRAMES: u64 = 30;

/// Decoders started ahead of a cut (`preroll`) kept at most.
const MAX_WARM: usize = 6;

struct Warm {
    source: String,
    decoder: VideoDecoder,
}

pub struct Renderer {
    adapter: wgpu::Adapter,
    device: wgpu::Device,
    queue: wgpu::Queue,
    pub width: u32,
    pub height: u32,
    sampler: wgpu::Sampler,
    builtin_bgl: wgpu::BindGroupLayout,
    pass_bgl: wgpu::BindGroupLayout,
    draw_pipe: wgpu::RenderPipeline,
    comp_pipe: wgpu::RenderPipeline,
    mip_pipe: wgpu::RenderPipeline,
    mask_pipe: wgpu::RenderPipeline,
    passes: HashMap<String, Vec<wgpu::RenderPipeline>>,
    sources: HashMap<String, Source>,
    /// Keyed by source id and its occurrence in the scene, so one recording
    /// shown twice at different times decodes twice.
    textures: HashMap<(String, usize), SourceTex>,
    frame: u64,
    white: wgpu::Texture,
    pool: Vec<(u32, u32, wgpu::Texture)>,
    trecs: HashMap<PathBuf, beacon_media::Trec>,
    /// A GPU validation error since the last draw: wgpu's default handler
    /// panics, which would kill the preview thread; it fails the next draw instead.
    gpu_error: Arc<Mutex<Option<String>>>,
    cache_dir: Option<PathBuf>,
    output: wgpu::Texture,
    /// Decoders already running at upcoming positions, newest last.
    warm: Vec<Warm>,
    /// Seconds spent per stage, reported when `BEACON_PROFILE` is set.
    pub profile: Profile,
    /// Read video from proxies where a source has one and its size suffices
    /// (the live preview while scrubbing or playing; never for export).
    pub use_proxies: bool,
    /// Draw a scene even when one of its sources can't be read (the live
    /// preview): that layer keeps its last frame and the error is kept in
    /// `source_error`. Export fails instead.
    pub lenient_sources: bool,
    /// Decode H.264/HEVC natively through VideoToolbox (the live preview): seeks several times faster.
    pub native_decode: bool,
    pub source_error: Option<String>,
}

#[derive(Debug, Default, Clone, Copy)]
pub struct Profile {
    /// Starting decoders: reading frame indexes and spawning ffmpeg.
    pub open: f64,
    pub decode: f64,
    pub upload: f64,
    pub draw_and_readback: f64,
}

/// None for a degenerate transform (a scale of 0), which draws nothing.
fn inverse(m: &Affine) -> Option<Affine> {
    let [a, b, c, d, e, f] = *m;
    let det = a * d - b * c;
    if det.abs() < 1e-12 {
        return None;
    }
    let (ia, ib, ic, id) = (d / det, -b / det, -c / det, a / det);
    Some([ia, ib, ic, id, -(ia * e + ic * f), -(ib * e + id * f)])
}

fn scale_of(m: &Affine) -> f32 {
    (m[0] * m[3] - m[1] * m[2]).abs().sqrt()
}

fn premul(c: [f32; 4]) -> wgpu::Color {
    let a = c[3] as f64;
    wgpu::Color { r: c[0] as f64 * a, g: c[1] as f64 * a, b: c[2] as f64 * a, a }
}

fn mip_count(w: u32, h: u32) -> u32 {
    32 - w.max(h).max(1).leading_zeros()
}

impl Renderer {
    pub fn new(job: &Job) -> Result<Self> {
        Self::with_instance(job, &instance(), None)
    }

    /// `surface`: one the adapter must be able to present to (the live preview).
    pub fn with_instance(job: &Job, instance: &wgpu::Instance, surface: Option<&wgpu::Surface>) -> Result<Self> {
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            compatible_surface: surface,
            ..Default::default()
        }))
        .map_err(|e| Error::Gpu(e.to_string()))?;
        let (device, queue) =
            pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default())).map_err(|e| Error::Gpu(e.to_string()))?;
        let gpu_error = Arc::new(Mutex::new(None));
        let sink = gpu_error.clone();
        device.on_uncaptured_error(Arc::new(move |e: wgpu::Error| {
            if let Ok(mut slot) = sink.lock() {
                slot.get_or_insert_with(|| e.to_string());
            }
        }));

        let builtin = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("builtin"),
            source: wgpu::ShaderSource::Wgsl(include_str!("builtin.wgsl").into()),
        });
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::MipmapFilterMode::Linear,
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            ..Default::default()
        });
        let uniform = |binding| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
            ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None },
            count: None,
        };
        let texture = |binding| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: true },
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
            count: None,
        };
        let sampler_entry = |binding| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
            count: None,
        };
        let builtin_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("builtin"),
            entries: &[uniform(0), texture(1), sampler_entry(2)],
        });
        let pass_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("pass"),
            entries: &[uniform(0), uniform(1), texture(2), texture(3), sampler_entry(4)],
        });

        let additive = wgpu::BlendState {
            color: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::One, operation: wgpu::BlendOperation::Add },
            alpha: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::One, operation: wgpu::BlendOperation::Add },
        };
        let over = wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING;
        let draw_pipe = pipeline(&device, &builtin, &builtin_bgl, "vs_draw", "fs_draw", Some(additive));
        let comp_pipe = pipeline(&device, &builtin, &builtin_bgl, "vs_full", "fs_composite", Some(over));
        let mip_pipe = pipeline(&device, &builtin, &builtin_bgl, "vs_full", "fs_mip", None);
        let mask_pipe = pipeline(&device, &builtin, &builtin_bgl, "vs_full", "fs_mask", Some(over));

        let mut passes = HashMap::new();
        for (id, def) in &job.passes {
            let src = format!("{}\n{}", include_str!("prelude.wgsl"), def.wgsl);
            let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
            let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some(id), source: wgpu::ShaderSource::Wgsl(src.into()) });
            let steps: Vec<_> = def.steps.iter().map(|entry| pipeline(&device, &module, &pass_bgl, "vs_full", entry, None)).collect();
            if let Some(err) = pollster::block_on(scope.pop()) {
                return Err(Error::Scene(format!("pass \"{id}\": {err}")));
            }
            passes.insert(id.clone(), steps);
        }

        let white = device.create_texture_with_data(
            &queue,
            &tex_desc(1, 1, 1, wgpu::TextureUsages::TEXTURE_BINDING),
            wgpu::util::TextureDataOrder::LayerMajor,
            &[255; 4],
        );
        let output = device.create_texture(&tex_desc(job.width, job.height, 1, rt_usage()));
        Ok(Self {
            adapter,
            device,
            queue,
            width: job.width,
            height: job.height,
            sampler,
            builtin_bgl,
            pass_bgl,
            draw_pipe,
            comp_pipe,
            mip_pipe,
            mask_pipe,
            passes,
            sources: job.sources.clone(),
            textures: HashMap::new(),
            frame: 0,
            white,
            pool: Vec::new(),
            trecs: HashMap::new(),
            gpu_error,
            cache_dir: job.cache_dir.as_ref().map(PathBuf::from),
            output,
            warm: Vec::new(),
            profile: Profile::default(),
            use_proxies: false,
            lenient_sources: false,
            native_decode: false,
            source_error: None,
        })
    }

    /// Registers the sources a scene defines, without drawing it.
    pub fn add_sources(&mut self, scene: &Scene) {
        self.sources.extend(scene.sources.iter().map(|(k, v)| (k.clone(), v.clone())));
    }

    /// Renders one scene and returns straight-alpha RGBA pixels.
    pub fn render(&mut self, scene: &Scene) -> Result<Vec<u8>> {
        let enc = self.draw(scene)?;
        let t = std::time::Instant::now();
        let output = self.output.clone();
        let pixels = self.read_back(enc, &output);
        self.profile.draw_and_readback += t.elapsed().as_secs_f64();
        // An export must not write a frame the GPU rejected.
        self.check_gpu()?;
        Ok(pixels)
    }

    /// Draws one scene into `output()` (premultiplied) and returns the
    /// encoder, not yet submitted, so the caller can add its own work.
    pub fn draw(&mut self, scene: &Scene) -> Result<wgpu::CommandEncoder> {
        self.check_gpu()?;
        self.sources.extend(scene.sources.iter().map(|(k, v)| (k.clone(), v.clone())));
        let mut enc = self.device.create_command_encoder(&Default::default());
        self.start_seeks(scene)?;
        let mut seen = HashMap::new();
        self.prepare(&scene.layers, &mut seen, 1.0, &mut enc)?;
        let t = std::time::Instant::now();
        let output = self.output.clone();
        let mut seen = HashMap::new();
        self.draw_layers(&mut enc, &output, self.width, self.height, scene.background, &scene.layers, &mut seen)?;
        self.profile.draw_and_readback += t.elapsed().as_secs_f64();
        let frame = self.frame;
        self.textures.retain(|_, st| frame - st.last_used <= KEEP_FRAMES);
        self.frame += 1;
        Ok(enc)
    }

    pub fn adapter(&self) -> &wgpu::Adapter {
        &self.adapter
    }

    pub fn device(&self) -> &wgpu::Device {
        &self.device
    }

    pub fn queue(&self) -> &wgpu::Queue {
        &self.queue
    }

    /// The canvas the last `draw` rendered, premultiplied RGBA.
    pub fn output(&self) -> &wgpu::Texture {
        &self.output
    }

    /// Straight-alpha RGBA of any texture in this renderer's format.
    /// The GPU error recorded since the last check, if any.
    pub fn check_gpu(&self) -> Result<()> {
        match self.gpu_error.lock().ok().and_then(|mut e| e.take()) {
            Some(e) => Err(Error::Gpu(e)),
            None => Ok(()),
        }
    }

    pub fn read_pixels(&mut self, enc: wgpu::CommandEncoder, tex: &wgpu::Texture) -> Vec<u8> {
        self.read_back(enc, tex)
    }

    /// Decodes and uploads every source the scene shows before drawing.
    /// `parent`: target pixels per pixel of the canvas these layers are on (groups nest).
    fn prepare(&mut self, layers: &[Layer], seen: &mut HashMap<String, usize>, parent: f32, enc: &mut wgpu::CommandEncoder) -> Result<()> {
        for layer in layers {
            let Layer::Visual(v) = layer else { continue };
            match &v.content {
                Content::Source { source, time } => {
                    let n = seen.entry(source.clone()).or_insert(0);
                    let key = (source.clone(), *n);
                    *n += 1;
                    let scale = std::iter::once(&v.transform).chain(v.motion.iter()).map(scale_of).fold(0.0f32, f32::max) * parent;
                    self.prepare_source(key, *time, scale as f64, enc)?;
                }
                Content::Group { layers, .. } => {
                    let scale = std::iter::once(&v.transform).chain(v.motion.iter()).map(scale_of).fold(0.0f32, f32::max);
                    self.prepare(layers, seen, parent * scale, enc)?
                }
                Content::Solid { .. } => {}
            }
        }
        Ok(())
    }

    /// `scale`: target pixels per content pixel, so video can be decoded no larger than drawn.
    fn prepare_source(&mut self, key: (String, usize), time: f64, scale: f64, enc: &mut wgpu::CommandEncoder) -> Result<()> {
        let def = self.sources.get(&key.0).ok_or_else(|| Error::Scene(format!("unknown source \"{}\"", key.0)))?.clone();
        let factor = sources::decode_factor(scale);
        let proxy = self.wants_proxy(&def, factor);
        let fits = |d: &VideoDecoder| d.scale == factor && d.proxy == proxy;
        let stale = self.textures.get(&key).and_then(|t| t.decoder.as_ref()).is_some_and(|d| !fits(d));
        let mut spare = None;
        let mut reuse = None;
        if stale {
            let st = self.textures.remove(&key).unwrap();
            let old = st.decoder.unwrap();
            reuse = st.spare.filter(|d| fits(d));
            spare = (old.scale == factor).then_some(old);
        }
        let fresh = !self.textures.contains_key(&key);
        if fresh {
            let (pixels, decoder) = match &def {
                Source::Video { .. } => {
                    let d = match reuse {
                        Some(d) => d,
                        None => match self.take_warm(&key.0, &def, factor, time) {
                            Some(d) => d,
                            None => self.open_video(&def, factor)?,
                        },
                    };
                    (sources::Pixels { width: d.width, height: d.height, data: Vec::new() }, Some(d))
                }
                still => (sources::load_still(still, &mut self.trecs)?, None),
            };
            let tex = self.device.create_texture(&tex_desc(pixels.width, pixels.height, mip_count(pixels.width, pixels.height), rt_usage()));
            let st = SourceTex { tex, width: pixels.width, height: pixels.height, decoder, spare, last_used: self.frame };
            if st.decoder.is_none() {
                self.upload(&st, &pixels.data, enc);
            }
            self.textures.insert(key.clone(), st);
        }
        let reach = self.textures[&key].decoder.as_ref().map(|d| d.can_reach(d.frame_for(time)));
        if reach == Some(false)
            && let Some(w) = self.take_warm(&key.0, &def, factor, time)
        {
            self.textures.get_mut(&key).unwrap().decoder = Some(w);
        }
        let st = self.textures.get_mut(&key).unwrap();
        st.last_used = self.frame;
        if let Some(d) = st.decoder.as_mut() {
            let i = d.frame_for(time);
            let t = std::time::Instant::now();
            // A new texture for a decoder already on this frame (the spare swapped back) still needs its pixels.
            let changed = match d.seek_to(i).map(|c| c || (fresh && d.has_frame())) {
                Ok(c) => c,
                Err(e) if self.lenient_sources => {
                    self.source_error = Some(e.to_string());
                    false
                }
                Err(e) => return Err(e),
            };
            self.profile.decode += t.elapsed().as_secs_f64();
            if changed {
                let t = std::time::Instant::now();
                let st = &self.textures[&key];
                self.upload(st, st.decoder.as_ref().unwrap().pixels(), enc);
                self.profile.upload += t.elapsed().as_secs_f64();
            }
        }
        Ok(())
    }

    /// Starts every decoder that must seek for this scene before waiting on
    /// any, so a jump costs one ffmpeg start, not one per source in turn.
    fn start_seeks(&mut self, scene: &Scene) -> Result<()> {
        let mut wanted = Vec::new();
        collect_videos(&scene.layers, 1.0, &mut wanted);
        let mut seen: HashMap<&str, usize> = HashMap::new();
        for (source, time, _) in &wanted {
            let n = seen.entry(source).or_insert(0);
            let key = (source.clone(), *n);
            *n += 1;
            let proxy = self.sources.get(source).is_some_and(|def| self.wants_proxy(def, 1.0));
            let st = self.textures.get_mut(&key);
            let d = st.and_then(|st| if st.decoder.as_ref().is_some_and(|d| d.proxy == proxy) { st.decoder.as_mut() } else { st.spare.as_mut().filter(|d| d.proxy == proxy) });
            if let Some(d) = d {
                let i = d.frame_for(*time);
                if !d.can_reach(i) && !self.warm.iter().any(|w| w.source == *source && w.decoder.can_reach(w.decoder.frame_for(*time))) {
                    d.start_at(i)?;
                }
            }
        }
        Ok(())
    }

    /// Whether `def` would be read from its proxy. Moving frames may be up to
    /// half the needed resolution; settled ones are drawn from the originals.
    fn wants_proxy(&self, def: &Source, _factor: f64) -> bool {
        matches!(def, Source::Video { proxy: Some(_), .. } if self.use_proxies)
    }

    fn open_video(&mut self, def: &Source, factor: f64) -> Result<VideoDecoder> {
        let t = std::time::Instant::now();
        let d = self.open_video_inner(def, factor);
        self.profile.open += t.elapsed().as_secs_f64();
        d
    }

    fn open_video_inner(&self, def: &Source, factor: f64) -> Result<VideoDecoder> {
        let Source::Video { path, stream, proxy } = def else { return Err(Error::Source("not a video".into())) };
        let mut d = match proxy {
            Some(p) if self.wants_proxy(def, factor) => {
                let mut d = VideoDecoder::new(&p.path, 0, self.cache_dir.as_deref(), (factor / p.factor).min(1.0))?;
                d.proxy = true;
                d
            }
            _ => VideoDecoder::new(path, *stream, self.cache_dir.as_deref(), factor)?,
        };
        d.scale = factor;
        d.native = self.native_decode;
        Ok(d)
    }

    fn take_warm(&mut self, source: &str, def: &Source, factor: f64, time: f64) -> Option<VideoDecoder> {
        let proxy = self.wants_proxy(def, factor);
        let i = self.warm.iter().position(|w| w.source == source && w.decoder.scale == factor && w.decoder.proxy == proxy && w.decoder.can_reach(w.decoder.frame_for(time)))?;
        Some(self.warm.remove(i).decoder)
    }

    /// Starts decoders for the video a scene shows, without drawing it: send
    /// the scene at an upcoming cut so playback doesn't stall when it gets there.
    pub fn preroll(&mut self, scene: &Scene) -> Result<()> {
        self.sources.extend(scene.sources.iter().map(|(k, v)| (k.clone(), v.clone())));
        let mut wanted = Vec::new();
        collect_videos(&scene.layers, 1.0, &mut wanted);
        for (source, time, scale) in wanted {
            let Some(def @ Source::Video { .. }) = self.sources.get(&source).cloned() else { continue };
            let factor = sources::decode_factor(scale as f64);
            let proxy = self.wants_proxy(&def, factor);
            let ready = |d: &VideoDecoder| d.scale == factor && d.proxy == proxy && d.can_reach(d.frame_for(time));
            let showing = self.textures.iter().any(|((s, _), st)| *s == source && st.decoder.as_ref().is_some_and(ready));
            if showing || self.warm.iter().any(|w| w.source == source && ready(&w.decoder)) {
                continue;
            }
            let mut d = self.open_video(&def, factor)?;
            d.start_at(d.frame_for(time))?;
            self.warm.push(Warm { source, decoder: d });
            if self.warm.len() > MAX_WARM {
                self.warm.remove(0);
            }
        }
        Ok(())
    }

    fn upload(&self, st: &SourceTex, data: &[u8], enc: &mut wgpu::CommandEncoder) {
        self.queue.write_texture(
            wgpu::TexelCopyTextureInfo { texture: &st.tex, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            data,
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(st.width * 4), rows_per_image: Some(st.height) },
            wgpu::Extent3d { width: st.width, height: st.height, depth_or_array_layers: 1 },
        );
        for level in 1..st.tex.mip_level_count() {
            let view = |l| st.tex.create_view(&wgpu::TextureViewDescriptor { base_mip_level: l, mip_level_count: Some(1), ..Default::default() });
            let (src, dst) = (view(level - 1), view(level));
            let bg = self.builtin_group(&[0u8; 16], &src);
            run_fullscreen(enc, &dst, None, &self.mip_pipe, &bg);
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn draw_layers(
        &mut self,
        enc: &mut wgpu::CommandEncoder,
        target: &wgpu::Texture,
        w: u32,
        h: u32,
        background: [f32; 4],
        layers: &[Layer],
        seen: &mut HashMap<String, usize>,
    ) -> Result<()> {
        clear(enc, target, premul(background));
        for layer in layers {
            match layer {
                Layer::Visual(v) => self.draw_visual(enc, target, w, h, v, seen)?,
                Layer::Backdrop(b) => self.draw_backdrop(enc, target, w, h, b)?,
            }
        }
        Ok(())
    }

    fn draw_visual(
        &mut self,
        enc: &mut wgpu::CommandEncoder,
        target: &wgpu::Texture,
        w: u32,
        h: u32,
        v: &Visual,
        seen: &mut HashMap<String, usize>,
    ) -> Result<()> {
        let (content, color, group_tex) = match &v.content {
            Content::Source { source, .. } => {
                let n = seen.entry(source.clone()).or_insert(0);
                let key = (source.clone(), *n);
                *n += 1;
                (self.textures[&key].tex.clone(), [1.0; 4], None)
            }
            Content::Solid { color } => (self.white.clone(), [color[0] * color[3], color[1] * color[3], color[2] * color[3], color[3]], None),
            Content::Group { background, layers } => {
                let (gw, gh) = (v.size[0].round().max(1.0) as u32, v.size[1].round().max(1.0) as u32);
                let g = self.take(gw, gh);
                self.draw_layers(enc, &g, gw, gh, *background, layers, seen)?;
                (g.clone(), [1.0; 4], Some(g))
            }
        };

        let local = [v.size[0] - v.crop[0] - v.crop[2], v.size[1] - v.crop[1] - v.crop[3]];
        let inv = inverse(&v.transform);
        let Some(inv) = inv.filter(|_| local[0] > 0.0 && local[1] > 0.0) else {
            if let Some(g) = group_tex {
                self.give(g);
            }
            return Ok(());
        };
        let layer_tex = self.take(w, h);
        clear(enc, &layer_tex, wgpu::Color::TRANSPARENT);
        let samples: Vec<&Affine> = std::iter::once(&v.transform).chain(v.motion.iter()).collect();
        let weight = 1.0 / samples.len() as f32;
        let content_view = content.create_view(&Default::default());
        {
            let view = layer_tex.create_view(&Default::default());
            let mut rp = begin(enc, &view, None);
            for (i, m) in samples.iter().enumerate() {
                let p = if i == 0 { v.perspective } else { [0.0; 2] };
                let u = DrawU {
                    m0: [m[0], m[1], m[2], m[3]],
                    m1: [m[4], m[5], w as f32, h as f32],
                    rect: [v.crop[0], v.crop[1], local[0], local[1]],
                    content: [v.size[0], v.size[1], weight, 0.0],
                    radius: v.radius,
                    color,
                    margin: [2.0 / scale_of(m).max(1e-3), p[0], p[1], 0.0],
                };
                let bg = self.builtin_group(bytemuck::bytes_of(&u), &content_view);
                rp.set_pipeline(&self.draw_pipe);
                rp.set_bind_group(0, Some(&bg), &[]);
                rp.draw(0..6, 0..1);
            }
        }
        if let Some(g) = group_tex {
            self.give(g);
        }
        let frame = PassFrameU {
            inv0: [inv[0], inv[1], inv[2], inv[3]],
            inv1: [inv[4], inv[5], w as f32, h as f32],
            layer: [local[0], local[1], scale_of(&v.transform), 0.0],
            radius: v.radius,
        };
        let layer_tex = self.run_passes(enc, layer_tex, w, h, frame, &v.passes)?;
        let bg = self.builtin_group(bytemuck::cast_slice(&[v.opacity, 0.0f32, 0.0, 0.0]), &layer_tex.create_view(&Default::default()));
        run_fullscreen(enc, &target.create_view(&Default::default()), Some(()), &self.comp_pipe, &bg);
        self.give(layer_tex);
        Ok(())
    }

    fn draw_backdrop(&mut self, enc: &mut wgpu::CommandEncoder, target: &wgpu::Texture, w: u32, h: u32, b: &Backdrop) -> Result<()> {
        let Some(inv) = inverse(&b.transform) else { return Ok(()) };
        let copy = self.take(w, h);
        enc.copy_texture_to_texture(target.as_image_copy(), copy.as_image_copy(), target.size());
        let frame = PassFrameU {
            inv0: [inv[0], inv[1], inv[2], inv[3]],
            inv1: [inv[4], inv[5], w as f32, h as f32],
            layer: [b.size[0], b.size[1], scale_of(&b.transform), 0.0],
            radius: b.radius,
        };
        let processed = self.run_passes(enc, copy, w, h, frame, &b.passes)?;
        #[repr(C)]
        #[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
        struct MaskU {
            inv0: [f32; 4],
            inv1: [f32; 4],
            size: [f32; 4],
            radius: [f32; 4],
        }
        let u = MaskU {
            inv0: frame.inv0,
            inv1: frame.inv1,
            size: [b.size[0], b.size[1], if b.invert { 1.0 } else { 0.0 }, b.opacity],
            radius: b.radius,
        };
        let bg = self.builtin_group(bytemuck::bytes_of(&u), &processed.create_view(&Default::default()));
        run_fullscreen(enc, &target.create_view(&Default::default()), Some(()), &self.mask_pipe, &bg);
        self.give(processed);
        Ok(())
    }

    fn run_passes(
        &mut self,
        enc: &mut wgpu::CommandEncoder,
        input: wgpu::Texture,
        w: u32,
        h: u32,
        mut frame: PassFrameU,
        passes: &[PassUse],
    ) -> Result<wgpu::Texture> {
        let mut current = input;
        for p in passes {
            let steps = self.passes.get(&p.pass).ok_or_else(|| Error::Scene(format!("unknown pass \"{}\"", p.pass)))?.clone();
            if p.params.len() > MAX_PARAMS {
                return Err(Error::Scene(format!("pass \"{}\": more than {MAX_PARAMS} params", p.pass)));
            }
            let mut params = [0f32; MAX_PARAMS];
            params[..p.params.len()].copy_from_slice(&p.params);
            let params_buf = self.uniform(bytemuck::cast_slice(&params));
            let orig = current;
            let orig_view = orig.create_view(&Default::default());
            let mut prev: Option<wgpu::Texture> = None;
            for (i, step) in steps.iter().enumerate() {
                frame.layer[3] = i as f32;
                let out = self.take(w, h);
                let src_view = prev.as_ref().unwrap_or(&orig).create_view(&Default::default());
                let frame_buf = self.uniform(bytemuck::bytes_of(&frame));
                let bg = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: None,
                    layout: &self.pass_bgl,
                    entries: &[
                        wgpu::BindGroupEntry { binding: 0, resource: frame_buf.as_entire_binding() },
                        wgpu::BindGroupEntry { binding: 1, resource: params_buf.as_entire_binding() },
                        wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(&src_view) },
                        wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::TextureView(&orig_view) },
                        wgpu::BindGroupEntry { binding: 4, resource: wgpu::BindingResource::Sampler(&self.sampler) },
                    ],
                });
                run_fullscreen(enc, &out.create_view(&Default::default()), None, step, &bg);
                if let Some(t) = prev.replace(out) {
                    self.give(t);
                }
            }
            current = match prev {
                Some(t) => {
                    self.give(orig);
                    t
                }
                None => orig,
            };
        }
        Ok(current)
    }

    fn read_back(&mut self, mut enc: wgpu::CommandEncoder, tex: &wgpu::Texture) -> Vec<u8> {
        let (w, h) = (tex.width(), tex.height());
        let padded = (w * 4).div_ceil(256) * 256;
        let buf = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size: (padded * h) as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        enc.copy_texture_to_buffer(
            tex.as_image_copy(),
            wgpu::TexelCopyBufferInfo { buffer: &buf, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(padded), rows_per_image: Some(h) } },
            tex.size(),
        );
        self.queue.submit([enc.finish()]);
        buf.slice(..).map_async(wgpu::MapMode::Read, |_| {});
        self.device.poll(wgpu::PollType::wait_indefinitely()).expect("gpu poll");
        let mut out = vec![0u8; (w * h * 4) as usize];
        {
            let data = buf.slice(..).get_mapped_range().expect("mapped readback");
            for y in 0..h as usize {
                let r = y * padded as usize;
                out[y * w as usize * 4..(y + 1) * w as usize * 4].copy_from_slice(&data[r..r + w as usize * 4]);
            }
        }
        for p in out.as_chunks_mut::<4>().0 {
            let a = p[3] as u32;
            if a > 0 && a < 255 {
                for c in &mut p[..3] {
                    *c = ((*c as u32 * 255 + a / 2) / a).min(255) as u8;
                }
            }
        }
        out
    }

    fn take(&mut self, w: u32, h: u32) -> wgpu::Texture {
        match self.pool.iter().position(|(pw, ph, _)| (*pw, *ph) == (w, h)) {
            Some(i) => self.pool.swap_remove(i).2,
            None => self.device.create_texture(&tex_desc(w, h, 1, rt_usage())),
        }
    }

    fn give(&mut self, t: wgpu::Texture) {
        self.pool.push((t.width(), t.height(), t));
    }

    fn uniform(&self, data: &[u8]) -> wgpu::Buffer {
        self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: None, contents: data, usage: wgpu::BufferUsages::UNIFORM })
    }

    fn builtin_group(&self, uniform: &[u8], view: &wgpu::TextureView) -> wgpu::BindGroup {
        let buf = self.uniform(uniform);
        self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &self.builtin_bgl,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: buf.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(view) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(&self.sampler) },
            ],
        })
    }
}

/// (source, media time, target pixels per content pixel) of every video a layer list draws.
fn collect_videos(layers: &[Layer], parent: f32, out: &mut Vec<(String, f64, f32)>) {
    for layer in layers {
        let Layer::Visual(v) = layer else { continue };
        let scale = std::iter::once(&v.transform).chain(v.motion.iter()).map(scale_of).fold(0.0f32, f32::max) * parent;
        match &v.content {
            Content::Source { source, time } => out.push((source.clone(), *time, scale)),
            Content::Group { layers, .. } => collect_videos(layers, scale, out),
            Content::Solid { .. } => {}
        }
    }
}

pub(crate) fn instance() -> wgpu::Instance {
    wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle())
}

pub(crate) fn rt_usage() -> wgpu::TextureUsages {
    wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::COPY_DST
}

pub(crate) fn tex_desc(w: u32, h: u32, mips: u32, usage: wgpu::TextureUsages) -> wgpu::TextureDescriptor<'static> {
    wgpu::TextureDescriptor {
        label: None,
        size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        mip_level_count: mips,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: FMT,
        usage,
        view_formats: &[],
    }
}

fn pipeline(device: &wgpu::Device, module: &wgpu::ShaderModule, bgl: &wgpu::BindGroupLayout, vs: &str, fs: &str, blend: Option<wgpu::BlendState>) -> wgpu::RenderPipeline {
    let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: None, bind_group_layouts: &[Some(bgl)], immediate_size: 0 });
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some(fs),
        layout: Some(&layout),
        vertex: wgpu::VertexState { module, entry_point: Some(vs), buffers: &[], compilation_options: Default::default() },
        fragment: Some(wgpu::FragmentState {
            module,
            entry_point: Some(fs),
            targets: &[Some(wgpu::ColorTargetState { format: FMT, blend, write_mask: wgpu::ColorWrites::ALL })],
            compilation_options: Default::default(),
        }),
        primitive: Default::default(),
        depth_stencil: None,
        multisample: Default::default(),
        multiview_mask: None,
        cache: None,
    })
}

fn begin<'a>(enc: &'a mut wgpu::CommandEncoder, view: &'a wgpu::TextureView, clear: Option<wgpu::Color>) -> wgpu::RenderPass<'a> {
    enc.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: None,
        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
            view,
            depth_slice: None,
            resolve_target: None,
            ops: wgpu::Operations { load: clear.map_or(wgpu::LoadOp::Load, wgpu::LoadOp::Clear), store: wgpu::StoreOp::Store },
        })],
        depth_stencil_attachment: None,
        timestamp_writes: None,
        occlusion_query_set: None,
        multiview_mask: None,
    })
}

fn clear(enc: &mut wgpu::CommandEncoder, tex: &wgpu::Texture, color: wgpu::Color) {
    begin(enc, &tex.create_view(&Default::default()), Some(color));
}

/// `load: Some(())` blends over the target's contents; `None` overwrites it.
fn run_fullscreen(enc: &mut wgpu::CommandEncoder, view: &wgpu::TextureView, load: Option<()>, pipe: &wgpu::RenderPipeline, bg: &wgpu::BindGroup) {
    let mut rp = begin(enc, view, if load.is_some() { None } else { Some(wgpu::Color::TRANSPARENT) });
    rp.set_pipeline(pipe);
    rp.set_bind_group(0, Some(bg), &[]);
    rp.draw(0..3, 0..1);
}
