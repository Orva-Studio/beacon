use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use wgpu::util::DeviceExt;

use crate::gpu::{lut_entry, linear_sampler, pipeline, sampler_entry, shader, texture_entry, uniform_entry};
use crate::scene::{Affine, Backdrop, Content, Job, Layer, PassUse, Scene, Source, Visual};
use crate::sources::{self, Frame, VideoDecoder};
use crate::{Error, Result};

pub(crate) const FMT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;
/// Where a layer's motion-blur samples are added up: each sample rounded to 8 bits on its own bands and tints
/// dark colours (16 samples of 18/255 make 16).
const ACCUM: wgpu::TextureFormat = wgpu::TextureFormat::Rgba16Float;
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
/// The still cache's key for stills read from files: images and recorded cursor shapes. Text and strokes aren't
/// kept: a draw-on or a resize makes a new one every frame, which would push the images out.
fn still_key(source: &Source) -> Option<String> {
    match source {
        Source::Image { path } => Some(path.clone()),
        Source::Cursor { path, index } => Some(format!("cursor\0{path}\0{index}")),
        _ => None,
    }
}

/// Render targets unused for this many frames are freed: a zoom on a tilted layer asks for a new size every frame.
const POOL_KEEP_FRAMES: u64 = 2;

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
    matte_bgl: wgpu::BindGroupLayout,
    matte_pipe: wgpu::RenderPipeline,
    accum_pipe: wgpu::RenderPipeline,
    accum_matte_pipe: wgpu::RenderPipeline,
    comp_pipe: wgpu::RenderPipeline,
    mip_pipe: wgpu::RenderPipeline,
    mask_pipe: wgpu::RenderPipeline,
    yuv_bgl: wgpu::BindGroupLayout,
    yuv_pipe: wgpu::RenderPipeline,
    /// Where VideoToolbox's frames become textures without a copy; None: every frame is converted on the CPU
    /// (`BEACON_DECODE_FFMPEG` or `BEACON_NO_ZERO_COPY`).
    surfaces: Option<crate::surface::TextureCache>,
    passes: HashMap<String, Vec<wgpu::RenderPipeline>>,
    /// `.cube` tables passes have named, by path; `no_lut` for those that name none.
    luts: HashMap<String, wgpu::Texture>,
    no_lut: wgpu::Texture,
    sources: HashMap<String, Source>,
    /// Keyed by source id and its occurrence in the scene, so one recording
    /// shown twice at different times decodes twice.
    textures: HashMap<(String, usize), SourceTex>,
    frame: u64,
    white: wgpu::Texture,
    /// Free render targets: width, height, the frame each was last used, the texture.
    pool: Vec<(u32, u32, u64, wgpu::Texture)>,
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
    /// Decode H.264/HEVC natively through VideoToolbox: seeks several times faster, and frames identical to
    /// FFmpeg's VideoToolbox path (`BEACON_DECODE_FFMPEG=1` uses that instead, for the parity test).
    pub native_decode: bool,
    pub source_error: Option<String>,
    /// Proxies that failed to open (deleted, or a cache record pointing at a moved file):
    /// their sources are read from the originals instead of not being drawn.
    bad_proxies: HashSet<String>,
    stills: sources::StillCache,
}

#[derive(Debug, Default, Clone, Copy)]
pub struct Profile {
    /// Starting decoders: reading frame indexes and spawning ffmpeg.
    pub open: f64,
    pub decode: f64,
    pub upload: f64,
    pub draw_and_readback: f64,
    /// Converting each frame on the GPU and handing it to VideoToolbox (the native encoder).
    pub encode: f64,
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

        let builtin = shader(&device, "builtin", include_str!("builtin.wgsl"));
        let sampler = linear_sampler(&device, true);
        let uniform = |binding| uniform_entry(binding, wgpu::ShaderStages::VERTEX_FRAGMENT);
        let texture = texture_entry;
        let builtin_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("builtin"),
            entries: &[uniform(0), texture(1), sampler_entry(2)],
        });
        let pass_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("pass"),
            entries: &[uniform(0), uniform(1), texture(2), texture(3), sampler_entry(4), lut_entry(5)],
        });

        let additive = wgpu::BlendState {
            color: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::One, operation: wgpu::BlendOperation::Add },
            alpha: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::One, operation: wgpu::BlendOperation::Add },
        };
        let over = wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING;
        let draw_pipe = pipeline(&device, &builtin, &builtin_bgl, "vs_draw", "fs_draw", FMT, Some(additive));
        let matte_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("matte"),
            entries: &[uniform(0), texture(1), sampler_entry(2), texture(3)],
        });
        let matte_pipe = pipeline(&device, &builtin, &matte_bgl, "vs_draw", "fs_draw_matte", FMT, Some(additive));
        let accum_pipe = pipeline(&device, &builtin, &builtin_bgl, "vs_draw", "fs_draw", ACCUM, Some(additive));
        let accum_matte_pipe = pipeline(&device, &builtin, &matte_bgl, "vs_draw", "fs_draw_matte", ACCUM, Some(additive));
        let comp_pipe = pipeline(&device, &builtin, &builtin_bgl, "vs_full", "fs_composite", FMT, Some(over));
        let mip_pipe = pipeline(&device, &builtin, &builtin_bgl, "vs_full", "fs_mip", FMT, None);
        let mask_pipe = pipeline(&device, &builtin, &builtin_bgl, "vs_full", "fs_mask", FMT, Some(over));
        let yuv_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("yuv"),
            entries: &[uniform(0), texture(1), texture(2), sampler_entry(3)],
        });
        let yuv = shader(&device, "yuv", include_str!("yuv.wgsl"));
        let yuv_pipe = pipeline(&device, &yuv, &yuv_bgl, "vs", "fs", FMT, None);
        let surfaces = (std::env::var_os("BEACON_DECODE_FFMPEG").is_none() && std::env::var_os("BEACON_NO_ZERO_COPY").is_none())
            .then(|| crate::surface::TextureCache::new(&device))
            .flatten();

        let mut passes = HashMap::new();
        for (id, def) in &job.passes {
            let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
            let module = shader(&device, id, &format!("{}\n{}", include_str!("prelude.wgsl"), def.wgsl));
            let steps: Vec<_> = def.steps.iter().map(|entry| pipeline(&device, &module, &pass_bgl, "vs_full", entry, FMT, None)).collect();
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
        let no_lut = lut_texture(&device, &queue, &crate::lut::Cube { size: 1, rgb: vec![1.0; 3] });
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
            matte_bgl,
            matte_pipe,
            accum_pipe,
            accum_matte_pipe,
            comp_pipe,
            mip_pipe,
            mask_pipe,
            yuv_bgl,
            yuv_pipe,
            surfaces,
            passes,
            luts: HashMap::new(),
            no_lut,
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
            native_decode: std::env::var_os("BEACON_DECODE_FFMPEG").is_none(),
            source_error: None,
            bad_proxies: HashSet::new(),
            stills: Default::default(),
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
        self.pool.retain(|(_, _, used, _)| frame - used <= POOL_KEEP_FRAMES);
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
        let mut videos = Vec::new();
        collect_videos(layers, parent, &mut videos);
        for (source, time, scale) in videos {
            let key = source_key(seen, &source);
            self.prepare_source(key, time, scale as f64, enc)?;
        }
        Ok(())
    }

    /// `scale`: target pixels per content pixel, so video can be decoded no larger than drawn.
    fn prepare_source(&mut self, key: (String, usize), time: f64, scale: f64, enc: &mut wgpu::CommandEncoder) -> Result<()> {
        let def = self.sources.get(&key.0).ok_or_else(|| Error::Scene(format!("unknown source \"{}\"", key.0)))?.clone();
        let factor = sources::decode_factor(scale);
        let proxy = self.wants_proxy(&def);
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
                    (Arc::new(sources::Pixels { width: d.width, height: d.height, data: Vec::new() }), Some(d))
                }
                // A screenshot or a cursor shape that comes back isn't decoded or rendered again.
                still => match still_key(still) {
                    Some(key) => match self.stills.get(&key) {
                        Some(px) => (px, None),
                        None => {
                            let px = Arc::new(sources::load_still(still, &mut self.trecs)?);
                            self.stills.put(&key, px.clone());
                            (px, None)
                        }
                    },
                    None => (Arc::new(sources::load_still(still, &mut self.trecs)?), None),
                },
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
                self.upload_frame(st, st.decoder.as_ref().unwrap().frame(), enc)?;
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
        let mut seen = HashMap::new();
        for (source, time, _) in &wanted {
            let key = source_key(&mut seen, source);
            let proxy = self.sources.get(source).is_some_and(|def| self.wants_proxy(def));
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
    fn wants_proxy(&self, def: &Source) -> bool {
        matches!(def, Source::Video { proxy: Some(p), .. } if self.use_proxies && !self.bad_proxies.contains(&p.path))
    }

    fn open_video(&mut self, def: &Source, factor: f64) -> Result<VideoDecoder> {
        let t = std::time::Instant::now();
        let d = self.open_video_inner(def, factor);
        self.profile.open += t.elapsed().as_secs_f64();
        d
    }

    fn open_video_inner(&mut self, def: &Source, factor: f64) -> Result<VideoDecoder> {
        let Source::Video { path, stream, proxy } = def else { return Err(Error::Source("not a video".into())) };
        let from_proxy = match proxy {
            Some(p) if self.wants_proxy(def) => match VideoDecoder::new(&p.path, 0, self.cache_dir.as_deref(), (factor / p.factor).min(1.0)) {
                Ok(mut d) => {
                    d.proxy = true;
                    Some(d)
                }
                Err(e) => {
                    self.source_error = Some(e.to_string());
                    self.bad_proxies.insert(p.path.clone());
                    None
                }
            },
            _ => None,
        };
        let mut d = match from_proxy {
            Some(d) => d,
            None => VideoDecoder::new(path, *stream, self.cache_dir.as_deref(), factor)?,
        };
        d.scale = factor;
        d.native = self.native_decode;
        d.surfaces = self.surfaces.is_some();
        Ok(d)
    }

    fn take_warm(&mut self, source: &str, def: &Source, factor: f64, time: f64) -> Option<VideoDecoder> {
        let proxy = self.wants_proxy(def);
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
            let proxy = self.wants_proxy(&def);
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

    fn upload_frame(&self, st: &SourceTex, frame: &Frame, enc: &mut wgpu::CommandEncoder) -> Result<()> {
        match frame {
            Frame::Rgba(data) => {
                self.upload(st, data, enc);
                Ok(())
            }
            Frame::Surface(surface, matrix) => {
                let cache = self.surfaces.as_ref().ok_or_else(|| Error::Source("a video frame came as a surface, which this renderer can't take".into()))?;
                let (y, uv) = cache.planes(&self.device, surface.clone()).ok_or_else(|| Error::Source("CoreVideo couldn't make textures of a video frame".into()))?;
                let (kr, kb) = matrix.kr_kb();
                let (w, h) = (st.width as f32, st.height as f32);
                let size = |t: &wgpu::Texture| (t.width() as f32, t.height() as f32);
                let ((yw, yh), (cw, ch)) = (size(&y), size(&uv));
                let u: [f32; 12] = [yw, yh, yw / w, yh / h, cw, ch, cw / w, ch / h, kr, kb, if surface.full_range { 1.0 } else { 0.0 }, 0.0];
                let buf = self.uniform(bytemuck::cast_slice(&u));
                let view = |t: &wgpu::Texture| t.create_view(&Default::default());
                let (yv, uvv) = (view(&y), view(&uv));
                let bg = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("yuv"),
                    layout: &self.yuv_bgl,
                    entries: &[
                        wgpu::BindGroupEntry { binding: 0, resource: buf.as_entire_binding() },
                        wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&yv) },
                        wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(&uvv) },
                        wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::Sampler(&self.sampler) },
                    ],
                });
                let dst = st.tex.create_view(&wgpu::TextureViewDescriptor { base_mip_level: 0, mip_level_count: Some(1), ..Default::default() });
                run_fullscreen(enc, &dst, None, &self.yuv_pipe, &bg);
                self.mips(st, enc);
                Ok(())
            }
        }
    }

    fn upload(&self, st: &SourceTex, data: &[u8], enc: &mut wgpu::CommandEncoder) {
        self.queue.write_texture(
            wgpu::TexelCopyTextureInfo { texture: &st.tex, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            data,
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(st.width * 4), rows_per_image: Some(st.height) },
            wgpu::Extent3d { width: st.width, height: st.height, depth_or_array_layers: 1 },
        );
        self.mips(st, enc);
    }

    fn mips(&self, st: &SourceTex, enc: &mut wgpu::CommandEncoder) {
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
                let key = source_key(seen, source);
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

        // Taken after the content, as `collect_videos` prepared them.
        let matte = v.matte.as_ref().map(|m| (self.textures[&source_key(seen, &m.source)].tex.create_view(&Default::default()), m.range));
        let local = [v.size[0] - v.crop[0] - v.crop[2], v.size[1] - v.crop[1] - v.crop[3]];
        let inv = inverse(&v.transform);
        let Some(inv) = inv.filter(|_| local[0] > 0.0 && local[1] > 0.0) else {
            if let Some(g) = group_tex {
                self.give(g);
            }
            return Ok(());
        };
        if !v.passes.is_empty() && (0..=v.motion.len()).any(|i| v.perspective_of(i) != [0.0, 0.0]) {
            let r = self.draw_tilted(enc, target, w, h, v, &content, color, local, matte.as_ref());
            if let Some(g) = group_tex {
                self.give(g);
            }
            return r;
        }
        let layer_tex = self.take(w, h);
        clear(enc, &layer_tex, wgpu::Color::TRANSPARENT);
        let samples: Vec<&Affine> = std::iter::once(&v.transform).chain(v.motion.iter()).collect();
        let weight = 1.0 / samples.len() as f32;
        let content_view = content.create_view(&Default::default());
        let accum = self.accumulator(&layer_tex, samples.len());
        {
            if let Some(a) = &accum {
                clear(enc, a, wgpu::Color::TRANSPARENT);
            }
            let view = accum.as_ref().unwrap_or(&layer_tex).create_view(&Default::default());
            let mut rp = begin(enc, &view, None);
            for (i, m) in samples.iter().enumerate() {
                let p = v.perspective_of(i);
                let u = DrawU {
                    m0: [m[0], m[1], m[2], m[3]],
                    m1: [m[4], m[5], w as f32, h as f32],
                    rect: [v.crop[0], v.crop[1], local[0], local[1]],
                    content: [v.size[0], v.size[1], weight, 0.0],
                    radius: v.radius,
                    color,
                    margin: [2.0 / scale_of(m).max(1e-3), p[0], p[1], 0.0],
                };
                self.draw_content(&mut rp, u, &content_view, matte.as_ref(), accum.is_some());
            }
        }
        self.resolve(enc, accum, &layer_tex);
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

    /// A tilted layer with passes: the passes run on the flat layer (with room around it for what they
    /// draw outside, like a shadow), which is then drawn in perspective. Passes map canvas pixels to the
    /// layer through its 2D transform, which a tilt doesn't follow.
    #[allow(clippy::too_many_arguments)]
    fn draw_tilted(
        &mut self,
        enc: &mut wgpu::CommandEncoder,
        target: &wgpu::Texture,
        w: u32,
        h: u32,
        v: &Visual,
        content: &wgpu::Texture,
        color: [f32; 4],
        local: [f32; 2],
        matte: Option<&(wgpu::TextureView, [f32; 2])>,
    ) -> Result<()> {
        let m = &v.transform;
        let longest = local[0].max(local[1]);
        // Small enough that the padded corners stay in front of the camera (W > 0.5 there).
        let tilt = (0..=v.motion.len()).map(|i| v.perspective_of(i)).map(|[a, b]| a.abs() + b.abs()).fold(0.0f32, f32::max);
        let pad_local = (longest * 0.15).min(0.5 / tilt.max(1e-6));
        // At the layer's own scale: passes take sizes in target pixels, so any other scale would change
        // how big a shadow or blur comes out.
        let s = scale_of(m).min(8192.0 / (longest + 2.0 * pad_local)).max(1e-3);
        let pad = pad_local * s;
        let (fw, fh) = (((local[0] * s + 2.0 * pad).ceil() as u32).max(1), ((local[1] * s + 2.0 * pad).ceil() as u32).max(1));
        let flat = self.take(fw, fh);
        clear(enc, &flat, wgpu::Color::TRANSPARENT);
        {
            let content_view = content.create_view(&Default::default());
            let u = DrawU {
                m0: [s, 0.0, 0.0, s],
                m1: [pad, pad, fw as f32, fh as f32],
                rect: [v.crop[0], v.crop[1], local[0], local[1]],
                content: [v.size[0], v.size[1], 1.0, 0.0],
                radius: v.radius,
                color,
                margin: [2.0 / s, 0.0, 0.0, 0.0],
            };
            let view = flat.create_view(&Default::default());
            let mut rp = begin(enc, &view, None);
            self.draw_content(&mut rp, u, &content_view, matte, false);
        }
        let frame = PassFrameU {
            inv0: [1.0 / s, 0.0, 0.0, 1.0 / s],
            inv1: [-pad / s, -pad / s, fw as f32, fh as f32],
            layer: [local[0], local[1], s, 0.0],
            radius: v.radius,
        };
        let flat = self.run_passes(enc, flat, fw, fh, frame, &v.passes)?;
        let layer_tex = self.take(w, h);
        clear(enc, &layer_tex, wgpu::Color::TRANSPARENT);
        let accum;
        {
            let samples: Vec<&Affine> = std::iter::once(m).chain(v.motion.iter()).collect();
            let weight = 1.0 / samples.len() as f32;
            let flat_view = flat.create_view(&Default::default());
            accum = self.accumulator(&layer_tex, samples.len());
            if let Some(a) = &accum {
                clear(enc, a, wgpu::Color::TRANSPARENT);
            }
            let view = accum.as_ref().unwrap_or(&layer_tex).create_view(&Default::default());
            let mut rp = begin(enc, &view, None);
            for (i, m) in samples.iter().enumerate() {
                let [g, gh] = v.perspective_of(i);
                // The flat texture's pixels onto the canvas: the layer's transform after undoing the scale
                // and padding, divided through so the perspective row's constant is 1 again.
                let k = 1.0 - (g + gh) * pad / s;
                let u = DrawU {
                    m0: [m[0] / s / k, m[1] / s / k, m[2] / s / k, m[3] / s / k],
                    m1: [(m[4] - (m[0] + m[2]) * pad / s) / k, (m[5] - (m[1] + m[3]) * pad / s) / k, w as f32, h as f32],
                    rect: [0.0, 0.0, fw as f32, fh as f32],
                    content: [fw as f32, fh as f32, weight, 0.0],
                    radius: [0.0; 4],
                    color: [1.0; 4],
                    margin: [0.0, g / s / k, gh / s / k, 0.0],
                };
                let bg = self.builtin_group(bytemuck::bytes_of(&u), &flat_view);
                rp.set_pipeline(if accum.is_some() { &self.accum_pipe } else { &self.draw_pipe });
                rp.set_bind_group(0, Some(&bg), &[]);
                rp.draw(0..6, 0..1);
            }
        }
        self.resolve(enc, accum, &layer_tex);
        self.give(flat);
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
            if let Some(path) = &p.lut
                && !self.luts.contains_key(path)
            {
                let cube = crate::lut::read(path)?;
                self.luts.insert(path.clone(), lut_texture(&self.device, &self.queue, &cube));
            }
            let lut_view = p.lut.as_ref().map_or(&self.no_lut, |path| &self.luts[path]).create_view(&Default::default());
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
                        wgpu::BindGroupEntry { binding: 5, resource: wgpu::BindingResource::TextureView(&lut_view) },
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
        self.take_as(w, h, FMT)
    }

    fn take_as(&mut self, w: u32, h: u32, format: wgpu::TextureFormat) -> wgpu::Texture {
        match self.pool.iter().position(|(pw, ph, _, t)| (*pw, *ph) == (w, h) && t.format() == format) {
            Some(i) => self.pool.swap_remove(i).3,
            None => self.device.create_texture(&wgpu::TextureDescriptor { format, ..tex_desc(w, h, 1, rt_usage()) }),
        }
    }

    /// Where `samples` draws go: `layer` itself for one, else a half-float texture added up into it by `resolve`.
    fn accumulator(&mut self, layer: &wgpu::Texture, samples: usize) -> Option<wgpu::Texture> {
        (samples > 1).then(|| self.take_as(layer.width(), layer.height(), ACCUM))
    }

    fn resolve(&mut self, enc: &mut wgpu::CommandEncoder, accum: Option<wgpu::Texture>, layer: &wgpu::Texture) {
        let Some(a) = accum else { return };
        let bg = self.builtin_group(bytemuck::cast_slice(&[1.0f32, 0.0, 0.0, 0.0]), &a.create_view(&Default::default()));
        run_fullscreen(enc, &layer.create_view(&Default::default()), None, &self.comp_pipe, &bg);
        self.give(a);
    }

    fn give(&mut self, t: wgpu::Texture) {
        self.pool.push((t.width(), t.height(), self.frame, t));
    }

    fn uniform(&self, data: &[u8]) -> wgpu::Buffer {
        self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: None, contents: data, usage: wgpu::BufferUsages::UNIFORM })
    }

    /// Draws a layer's content as `u` places it, through its matte when it has one.
    fn draw_content(&self, rp: &mut wgpu::RenderPass, mut u: DrawU, content: &wgpu::TextureView, matte: Option<&(wgpu::TextureView, [f32; 2])>, accum: bool) {
        let Some((view, [clear, opaque])) = matte else {
            let bg = self.builtin_group(bytemuck::bytes_of(&u), content);
            rp.set_pipeline(if accum { &self.accum_pipe } else { &self.draw_pipe });
            rp.set_bind_group(0, Some(&bg), &[]);
            return rp.draw(0..6, 0..1);
        };
        (u.content[3], u.margin[3]) = (*clear, *opaque);
        let buf = self.uniform(bytemuck::bytes_of(&u));
        let bg = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &self.matte_bgl,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: buf.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(content) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(&self.sampler) },
                wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::TextureView(view) },
            ],
        });
        rp.set_pipeline(if accum { &self.accum_matte_pipe } else { &self.matte_pipe });
        rp.set_bind_group(0, Some(&bg), &[]);
        rp.draw(0..6, 0..1);
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

/// A `.cube` table as a 3D half-float texture, filtered between its entries.
fn lut_texture(device: &wgpu::Device, queue: &wgpu::Queue, cube: &crate::lut::Cube) -> wgpu::Texture {
    let n = cube.size;
    let data: Vec<u16> = cube.rgb.as_chunks::<3>().0.iter().flat_map(|&[r, g, b]| [r, g, b, 1.0]).map(crate::lut::half).collect();
    device.create_texture_with_data(
        queue,
        &wgpu::TextureDescriptor {
            label: Some("lut"),
            size: wgpu::Extent3d { width: n, height: n, depth_or_array_layers: n },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D3,
            format: wgpu::TextureFormat::Rgba16Float,
            usage: wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        },
        wgpu::util::TextureDataOrder::LayerMajor,
        bytemuck::cast_slice(&data),
    )
}

/// The key of a source's next use in a frame, in drawing order: a source drawn twice (a stitched clip's repeats) gets a
/// texture each.
fn source_key(seen: &mut HashMap<String, usize>, source: &str) -> (String, usize) {
    let n = seen.entry(source.to_string()).or_insert(0);
    *n += 1;
    (source.to_string(), *n - 1)
}

/// (source, media time, target pixels per content pixel) of every video a layer list draws, in drawing order;
/// `parent`: target pixels per pixel of the canvas these layers are on (groups nest).
fn collect_videos(layers: &[Layer], parent: f32, out: &mut Vec<(String, f64, f32)>) {
    for layer in layers {
        let Layer::Visual(v) = layer else { continue };
        let scale = std::iter::once(&v.transform).chain(v.motion.iter()).map(scale_of).fold(0.0f32, f32::max) * parent;
        match &v.content {
            Content::Source { source, time } => out.push((source.clone(), *time, scale)),
            Content::Group { layers, .. } => collect_videos(layers, scale, out),
            Content::Solid { .. } => {}
        }
        if let Some(m) = &v.matte {
            out.push((m.source.clone(), m.time, scale));
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
