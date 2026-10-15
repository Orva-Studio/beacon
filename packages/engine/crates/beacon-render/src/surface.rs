//! VideoToolbox frames sampled by the GPU where they are: each NV12 plane of a frame's IOSurface becomes a Metal
//! texture through CoreVideo's texture cache, wrapped for wgpu. No copy, no CPU colour conversion.

use std::ffi::c_void;
use std::ptr::null_mut;

use beacon_decode::Surface;
use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2_metal::{MTLTexture, MTLTextureType};

#[link(name = "CoreVideo", kind = "framework")]
unsafe extern "C" {
    fn CVMetalTextureCacheCreate(alloc: *const c_void, attrs: *const c_void, device: *mut c_void, texture_attrs: *const c_void, out: *mut *mut c_void) -> i32;
    #[allow(clippy::too_many_arguments)]
    fn CVMetalTextureCacheCreateTextureFromImage(
        alloc: *const c_void,
        cache: *mut c_void,
        image: *mut c_void,
        attrs: *const c_void,
        format: usize,
        width: usize,
        height: usize,
        plane: usize,
        out: *mut *mut c_void,
    ) -> i32;
    fn CVMetalTextureCacheFlush(cache: *mut c_void, options: u64);
    fn CVMetalTextureGetTexture(texture: *mut c_void) -> *mut ProtocolObject<dyn MTLTexture>;
    fn CVPixelBufferGetWidthOfPlane(buf: *mut c_void, plane: usize) -> usize;
    fn CVPixelBufferGetHeightOfPlane(buf: *mut c_void, plane: usize) -> usize;
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFRelease(cf: *const c_void);
}

/// MTLPixelFormatR8Unorm and MTLPixelFormatRG8Unorm.
const R8: usize = 10;
const RG8: usize = 30;

/// What a plane's texture needs kept until the GPU is done with it: its CVMetalTexture and the frame.
struct Held {
    cv: *mut c_void,
    _surface: std::sync::Arc<Surface>,
}

// Released once, by wgpu, after the last command buffer using the texture has completed.
unsafe impl Send for Held {}
unsafe impl Sync for Held {}

impl Drop for Held {
    fn drop(&mut self) {
        unsafe { CFRelease(self.cv) };
    }
}

/// CoreVideo's cache of Metal textures over pixel buffers, for one wgpu device.
pub struct TextureCache {
    raw: *mut c_void,
}

// Used only from the renderer's thread; CoreVideo objects are thread safe to release.
unsafe impl Send for TextureCache {}

impl Drop for TextureCache {
    fn drop(&mut self) {
        unsafe { CFRelease(self.raw) };
    }
}

impl TextureCache {
    /// None when the device isn't Metal (it always is on macOS) or CoreVideo refuses.
    pub fn new(device: &wgpu::Device) -> Option<Self> {
        let hal = unsafe { device.as_hal::<wgpu::hal::api::Metal>() }?;
        let mtl = Retained::as_ptr(hal.raw_device()) as *mut c_void;
        let mut raw = null_mut();
        (unsafe { CVMetalTextureCacheCreate(std::ptr::null(), std::ptr::null(), mtl, std::ptr::null(), &mut raw) } == 0 && !raw.is_null()).then_some(Self { raw })
    }

    /// The frame's luma (R8) and chroma (RG8) planes as wgpu textures. They keep the frame alive until wgpu
    /// releases them, after the GPU has finished with them.
    pub fn planes(&self, device: &wgpu::Device, surface: Surface) -> Option<(wgpu::Texture, wgpu::Texture)> {
        unsafe { CVMetalTextureCacheFlush(self.raw, 0) };
        let surface = std::sync::Arc::new(surface);
        let plane = |i: usize, mtl_format: usize, format: wgpu::TextureFormat| -> Option<wgpu::Texture> {
            let buf = surface.as_ptr();
            let (w, h) = unsafe { (CVPixelBufferGetWidthOfPlane(buf, i), CVPixelBufferGetHeightOfPlane(buf, i)) };
            let mut cv = null_mut();
            let r = unsafe { CVMetalTextureCacheCreateTextureFromImage(std::ptr::null(), self.raw, buf, std::ptr::null(), mtl_format, w, h, i, &mut cv) };
            if r != 0 || cv.is_null() {
                return None;
            }
            let held = Held { cv, _surface: surface.clone() };
            let raw = unsafe { Retained::retain(CVMetalTextureGetTexture(cv)) }?;
            let (w, h) = (w as u32, h as u32);
            let hal = unsafe {
                wgpu::hal::metal::Device::texture_from_raw(
                    raw,
                    format,
                    MTLTextureType::Type2D,
                    1,
                    1,
                    wgpu::hal::CopyExtent { width: w, height: h, depth: 1 },
                    Some(Box::new(move || drop(held))),
                )
            };
            let desc = wgpu::TextureDescriptor {
                label: Some("video plane"),
                size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format,
                usage: wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            };
            Some(unsafe { device.create_texture_from_hal::<wgpu::hal::api::Metal>(hal, &desc, wgpu::TextureUses::RESOURCE) })
        };
        Some((plane(0, R8, wgpu::TextureFormat::R8Unorm)?, plane(1, RG8, wgpu::TextureFormat::Rg8Unorm)?))
    }
}
