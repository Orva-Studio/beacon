//! Export's frames straight from the GPU to VideoToolbox: the canvas is converted to BT.709 NV12 on the GPU, in
//! pixel buffers from AVAssetWriter's own pool, and appended. No readback, no CPU colour conversion, no pipe.

use std::collections::VecDeque;
use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::{Arc, mpsc};
use std::time::Duration;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2_av_foundation::{
    AVAssetWriter, AVAssetWriterInput, AVAssetWriterInputPixelBufferAdaptor, AVAssetWriterStatus, AVFileTypeQuickTimeMovie, AVMediaTypeVideo,
    AVVideoAverageBitRateKey, AVVideoCodecKey, AVVideoCodecTypeAppleProRes422HQ, AVVideoCodecTypeH264, AVVideoCodecTypeHEVC, AVVideoColorPrimariesKey,
    AVVideoColorPrimaries_ITU_R_709_2, AVVideoColorPropertiesKey, AVVideoCompressionPropertiesKey, AVVideoExpectedSourceFrameRateKey, AVVideoHeightKey,
    AVVideoMaxKeyFrameIntervalKey, AVVideoProfileLevelH264BaselineAutoLevel, AVVideoProfileLevelH264HighAutoLevel, AVVideoProfileLevelH264MainAutoLevel,
    AVVideoProfileLevelKey, AVVideoTransferFunctionKey, AVVideoTransferFunction_IEC_sRGB, AVVideoTransferFunction_ITU_R_709_2, AVVideoWidthKey,
    AVVideoYCbCrMatrixKey, AVVideoYCbCrMatrix_ITU_R_709_2,
};
use objc2_core_media::CMTime;
use objc2_core_video::{CVPixelBuffer, CVPixelBufferPool};
use objc2_foundation::{NSDictionary, NSNumber, NSString, NSURL};

use crate::gpu::{linear_sampler, pipeline, sampler_entry, shader, texture_entry, uniform_entry};
use crate::render::Renderer;
use crate::scene::{Codec, Encode, H264Profile};
use crate::surface::TextureCache;
use crate::{Error, Result};

#[link(name = "CoreVideo", kind = "framework")]
unsafe extern "C" {
    fn CVPixelBufferRelease(buf: *mut c_void);
    fn CVBufferSetAttachment(buf: *mut c_void, key: *const c_void, value: *const c_void, mode: u32);
    static kCVImageBufferColorPrimariesKey: *const c_void;
    static kCVImageBufferColorPrimaries_ITU_R_709_2: *const c_void;
    static kCVImageBufferTransferFunctionKey: *const c_void;
    static kCVImageBufferTransferFunction_ITU_R_709_2: *const c_void;
    static kCVImageBufferTransferFunction_sRGB: *const c_void;
    static kCVImageBufferYCbCrMatrixKey: *const c_void;
    static kCVImageBufferYCbCrMatrix_ITU_R_709_2: *const c_void;
}

/// '420v': 8-bit 4:2:0, video range.
const NV12: i64 = 0x3432_3076;

/// Frames converted and submitted but not yet appended: the GPU works on these while the next is drawn.
const IN_FLIGHT: usize = 3;

/// A pixel buffer from the pool, released when the GPU and this code are both done with it.
struct Buffer(*mut c_void);

// A retained CVPixelBuffer; CoreVideo's retain counts are thread safe.
unsafe impl Send for Buffer {}
unsafe impl Sync for Buffer {}

impl Drop for Buffer {
    fn drop(&mut self) {
        unsafe { CVPixelBufferRelease(self.0) };
    }
}

fn dict(pairs: &[(&NSString, &AnyObject)]) -> Retained<NSDictionary<NSString, AnyObject>> {
    let (keys, values): (Vec<&NSString>, Vec<&AnyObject>) = pairs.iter().copied().unzip();
    NSDictionary::from_slices(&keys, &values)
}

fn num(v: i64) -> Retained<NSNumber> {
    NSNumber::new_i64(v)
}

pub struct Encoder {
    writer: Retained<AVAssetWriter>,
    input: Retained<AVAssetWriterInput>,
    adaptor: Retained<AVAssetWriterInputPixelBufferAdaptor>,
    cache: TextureCache,
    bind: wgpu::BindGroup,
    luma: wgpu::RenderPipeline,
    chroma: wgpu::RenderPipeline,
    job: Encode,
    frames: i64,
    pending: VecDeque<(wgpu::SubmissionIndex, Arc<Buffer>, CMTime)>,
}

impl Encoder {
    pub fn new(renderer: &Renderer, job: &Encode) -> Result<Self> {
        let device = renderer.device();
        let cache = TextureCache::new(device).ok_or_else(|| Error::Gpu("CoreVideo's Metal texture cache is unavailable".into()))?;
        let fail = |what: &str| Error::Output(format!("{what}: {}", job.path));
        let _ = std::fs::remove_file(&job.path);
        let url = NSURL::fileURLWithPath(&NSString::from_str(&job.path));
        let writer = unsafe { AVAssetWriter::assetWriterWithURL_fileType_error(&url, AVFileTypeQuickTimeMovie.unwrap()) }
            .map_err(|e| Error::Output(format!("{}: {}", job.path, e.localizedDescription())))?;

        let settings = unsafe { Self::settings(job) };
        let input = unsafe { AVAssetWriterInput::assetWriterInputWithMediaType_outputSettings(AVMediaTypeVideo.unwrap(), Some(&settings)) };
        unsafe { input.setExpectsMediaDataInRealTime(false) };
        if !unsafe { writer.canAddInput(&input) } {
            return Err(fail("the encoder refused these settings"));
        }
        unsafe { writer.addInput(&input) };
        let attrs = dict(&[
            (&NSString::from_str("PixelFormatType"), num(NV12).as_ref()),
            (&NSString::from_str("Width"), num(job.width as i64).as_ref()),
            (&NSString::from_str("Height"), num(job.height as i64).as_ref()),
            (&NSString::from_str("MetalCompatibility"), NSNumber::new_bool(true).as_ref()),
            (&NSString::from_str("IOSurfaceProperties"), NSDictionary::<NSString, AnyObject>::new().as_ref()),
        ]);
        let adaptor = unsafe { AVAssetWriterInputPixelBufferAdaptor::assetWriterInputPixelBufferAdaptorWithAssetWriterInput_sourcePixelBufferAttributes(&input, Some(&attrs)) };
        if !unsafe { writer.startWriting() } {
            return Err(Error::Output(format!("{}: {}", job.path, unsafe { writer.error() }.map(|e| e.localizedDescription().to_string()).unwrap_or_default())));
        }
        unsafe { writer.startSessionAtSourceTime(CMTime::new(0, job.fps.num as i32)) };

        let module = shader(device, "nv12", include_str!("nv12.wgsl"));
        let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("nv12"),
            entries: &[uniform_entry(0, wgpu::ShaderStages::FRAGMENT), texture_entry(1), sampler_entry(2)],
        });
        let (luma, chroma) = (pipeline(device, &module, &bgl, "vs", "fs_luma", wgpu::TextureFormat::R8Unorm, None), pipeline(device, &module, &bgl, "vs", "fs_chroma", wgpu::TextureFormat::Rg8Unorm, None));
        let sampler = linear_sampler(device, false);
        let canvas = renderer.output();
        let u = [canvas.width() as f32, canvas.height() as f32, canvas.width() as f32 / job.width as f32, canvas.height() as f32 / job.height as f32];
        let buf = wgpu::util::DeviceExt::create_buffer_init(device, &wgpu::util::BufferInitDescriptor { label: None, contents: bytemuck::cast_slice(&u), usage: wgpu::BufferUsages::UNIFORM });
        let view = canvas.create_view(&Default::default());
        let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("nv12"),
            layout: &bgl,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: buf.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&view) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(&sampler) },
            ],
        });
        Ok(Self { writer, input, adaptor, cache, bind, luma, chroma, job: job.clone(), frames: 0, pending: VecDeque::new() })
    }

    /// AVAssetWriter's output settings: codec, size, data rate, keyframes, profile, and BT.709 colour.
    unsafe fn settings(job: &Encode) -> Retained<NSDictionary<NSString, AnyObject>> {
        unsafe {
            let transfer = if job.srgb { AVVideoTransferFunction_IEC_sRGB } else { AVVideoTransferFunction_ITU_R_709_2 }.unwrap();
            let color = dict(&[
                (AVVideoColorPrimariesKey.unwrap(), AVVideoColorPrimaries_ITU_R_709_2.unwrap().as_ref()),
                (AVVideoTransferFunctionKey.unwrap(), transfer.as_ref()),
                (AVVideoYCbCrMatrixKey.unwrap(), AVVideoYCbCrMatrix_ITU_R_709_2.unwrap().as_ref()),
            ]);
            let fps = (job.fps.num as f64 / job.fps.den as f64).round() as i64;
            let codec = match job.codec {
                Codec::H264 => AVVideoCodecTypeH264,
                Codec::Hevc => AVVideoCodecTypeHEVC,
                Codec::Prores => AVVideoCodecTypeAppleProRes422HQ,
            }
            .unwrap();
            let (rate, bitrate, keyframe) = (num(fps), num(job.bitrate as i64), num(job.keyframe as i64));
            let mut props: Vec<(&NSString, &AnyObject)> = vec![(AVVideoExpectedSourceFrameRateKey.unwrap(), rate.as_ref())];
            if job.codec != Codec::Prores {
                props.push((AVVideoAverageBitRateKey.unwrap(), bitrate.as_ref()));
                props.push((AVVideoMaxKeyFrameIntervalKey.unwrap(), keyframe.as_ref()));
            }
            if let (Codec::H264, Some(p)) = (job.codec, job.profile) {
                let level = match p {
                    H264Profile::Baseline => AVVideoProfileLevelH264BaselineAutoLevel,
                    H264Profile::Main => AVVideoProfileLevelH264MainAutoLevel,
                    H264Profile::High => AVVideoProfileLevelH264HighAutoLevel,
                }
                .unwrap();
                props.push((AVVideoProfileLevelKey.unwrap(), level.as_ref()));
            }
            let props = dict(&props);
            dict(&[
                (AVVideoCodecKey.unwrap(), codec.as_ref()),
                (AVVideoWidthKey.unwrap(), num(job.width as i64).as_ref()),
                (AVVideoHeightKey.unwrap(), num(job.height as i64).as_ref()),
                (AVVideoCompressionPropertiesKey.unwrap(), props.as_ref()),
                (AVVideoColorPropertiesKey.unwrap(), color.as_ref()),
            ])
        }
    }

    fn failed(&self) -> Error {
        Error::Output(format!("{}: {}", self.job.path, unsafe { self.writer.error() }.map(|e| e.localizedDescription().to_string()).unwrap_or_else(|| "the encoder stopped".into())))
    }

    /// Converts the canvas `renderer` last drew (with `enc`, not yet submitted) and queues it as the next frame;
    /// it is appended once the GPU has written it, up to `IN_FLIGHT` frames later.
    pub fn frame(&mut self, renderer: &Renderer, mut enc: wgpu::CommandEncoder) -> Result<()> {
        let pool: Retained<CVPixelBufferPool> = unsafe { self.adaptor.pixelBufferPool() }.ok_or_else(|| self.failed())?;
        let mut raw: *mut CVPixelBuffer = std::ptr::null_mut();
        if unsafe { CVPixelBufferPool::create_pixel_buffer(None, &pool, NonNull::from(&mut raw)) } != 0 || raw.is_null() {
            return Err(Error::Output("no pixel buffer for the encoder".into()));
        }
        let buffer = Arc::new(Buffer(raw.cast()));
        unsafe {
            let transfer = if self.job.srgb { kCVImageBufferTransferFunction_sRGB } else { kCVImageBufferTransferFunction_ITU_R_709_2 };
            for (k, v) in [(kCVImageBufferColorPrimariesKey, kCVImageBufferColorPrimaries_ITU_R_709_2), (kCVImageBufferTransferFunctionKey, transfer), (kCVImageBufferYCbCrMatrixKey, kCVImageBufferYCbCrMatrix_ITU_R_709_2)] {
                CVBufferSetAttachment(buffer.0, k, v, 1);
            }
        }
        let (y, uv) = unsafe { self.cache.targets(renderer.device(), buffer.0, buffer.clone()) }.ok_or_else(|| Error::Output("CoreVideo couldn't make textures of the encoder's frame".into()))?;
        for (target, pipe) in [(&y, &self.luma), (&uv, &self.chroma)] {
            let target = target.create_view(&Default::default());
            let mut rp = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: None,
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &target,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store },
                })],
                ..Default::default()
            });
            rp.set_pipeline(pipe);
            rp.set_bind_group(0, Some(&self.bind), &[]);
            rp.draw(0..3, 0..1);
        }
        let submitted = renderer.queue().submit([enc.finish()]);
        let time = unsafe { CMTime::new(self.frames * self.job.fps.den as i64, self.job.fps.num as i32) };
        self.pending.push_back((submitted, buffer, time));
        self.frames += 1;
        while self.pending.len() > IN_FLIGHT {
            self.append_oldest(renderer)?;
        }
        Ok(())
    }

    /// Appends the oldest queued frame once the GPU has written it (the encoder reads the IOSurface itself).
    fn append_oldest(&mut self, renderer: &Renderer) -> Result<()> {
        let Some((submitted, buffer, time)) = self.pending.pop_front() else { return Ok(()) };
        renderer.device().poll(wgpu::PollType::Wait { submission_index: Some(submitted), timeout: None }).map_err(|e| Error::Gpu(e.to_string()))?;
        renderer.check_gpu()?;
        // VideoToolbox takes frames as fast as it encodes them; wait for room rather than drop one.
        while !unsafe { self.input.isReadyForMoreMediaData() } {
            if unsafe { self.writer.status() } == AVAssetWriterStatus::Failed {
                return Err(self.failed());
            }
            std::thread::sleep(Duration::from_micros(500));
        }
        if !unsafe { self.adaptor.appendPixelBuffer_withPresentationTime(&*buffer.0.cast::<CVPixelBuffer>(), time) } {
            return Err(self.failed());
        }
        Ok(())
    }

    /// Finishes the file: the last frame lasts one frame.
    pub fn finish(mut self, renderer: &Renderer) -> Result<()> {
        while !self.pending.is_empty() {
            self.append_oldest(renderer)?;
        }
        unsafe { self.input.markAsFinished() };
        unsafe { self.writer.endSessionAtSourceTime(CMTime::new(self.frames * self.job.fps.den as i64, self.job.fps.num as i32)) };
        let (tx, rx) = mpsc::channel();
        let done = RcBlock::new(move || {
            let _ = tx.send(());
        });
        unsafe { self.writer.finishWritingWithCompletionHandler(&done) };
        rx.recv_timeout(Duration::from_secs(120)).map_err(|_| Error::Output(format!("{}: finishing timed out", self.job.path)))?;
        if unsafe { self.writer.status() } != AVAssetWriterStatus::Completed {
            return Err(self.failed());
        }
        Ok(())
    }
}
