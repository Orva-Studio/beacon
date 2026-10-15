// One video stream decoded in process with libavformat/libavcodec, kept open
// between seeks. H.264/HEVC/ProRes can decode through VideoToolbox, either as
// FFmpeg drives it or natively (the preview): packets go to an asynchronous
// VTDecompressionSession, so a seek's frames are decoded in parallel on the
// media engine instead of one at a time. Either way the frames are converted
// to RGBA at the size asked for with swscale, so they are identical.
#include <CoreVideo/CoreVideo.h>
#include <VideoToolbox/VideoToolbox.h>
#include <pthread.h>
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/hwcontext.h>
#include <libavutil/imgutils.h>
#include <libavutil/opt.h>
#include <libswscale/swscale.h>
#include <stdio.h>
#include <string.h>

typedef struct {
  AVFormatContext *fmt;
  AVCodecContext *ctx;
  AVBufferRef *hw;
  int stream;
  AVPacket *pkt;
  AVFrame *frame;
  AVFrame *sw;
  struct SwsContext *sws;
  int sws_key[6];
  int draining;
  double time_base;
  // The native VideoToolbox path (OTD_NATIVE).
  VTDecompressionSessionRef vt;
  CMVideoFormatDescriptionRef vt_format;
  pthread_mutex_t lock;
  pthread_cond_t arrived;
  // Decoded frames not yet returned, in the order they came out (decode order).
  CVPixelBufferRef out_buf[64];
  double out_pts[64];
  int outs;
  int in_flight;
  int vt_eof;
  // Frames held back for display order: the stream's reorder depth, at least REORDER.
  int reorder;
  // The first frame VideoToolbox failed to decode since the last seek; returned rather than skipped.
  OSStatus vt_status;
  // After a seek, packets go to VideoToolbox from the first keyframe, and those shown before it are skipped:
  // an open-GOP keyframe (HEVC's CRA, as AVFoundation's camera encoder writes) is followed by leading
  // pictures that reference frames before the seek, which VideoToolbox fails on where FFmpeg drops them.
  int need_key;
  int64_t key_pts;
} otd;

// How otd_open decodes (lib.rs's `Mode`).
enum otd_mode { OTD_SOFTWARE = 0, OTD_HARDWARE = 1, OTD_NATIVE = 2 };

// Frames kept back before the earliest is returned when the stream doesn't say how far its decode order
// runs ahead of display order (MP4 headers are read without probing, so `video_delay` is often 0).
#define REORDER 4
// Packets decoding at once on the media engine.
#define IN_FLIGHT 8

static void say(char *err, int len, const char *what, int code) {
  char msg[128] = "";
  if (code) av_strerror(code, msg, sizeof msg);
  snprintf(err, len, "%s%s%s", what, code ? ": " : "", msg);
}

static enum AVPixelFormat pick_hw(AVCodecContext *ctx, const enum AVPixelFormat *fmts) {
  for (const enum AVPixelFormat *p = fmts; *p != AV_PIX_FMT_NONE; p++)
    if (*p == AV_PIX_FMT_VIDEOTOOLBOX) return *p;
  return fmts[0];
}

static void vt_clear(otd *d) {
  if (d->vt) VTDecompressionSessionWaitForAsynchronousFrames(d->vt);
  pthread_mutex_lock(&d->lock);
  for (int i = 0; i < d->outs; i++) CVPixelBufferRelease(d->out_buf[i]);
  d->outs = 0;
  d->in_flight = 0;
  d->vt_eof = 0;
  d->vt_status = noErr;
  d->need_key = 1;
  d->key_pts = INT64_MIN;
  pthread_mutex_unlock(&d->lock);
}

void otd_close(otd *d) {
  if (!d) return;
  if (d->vt) {
    vt_clear(d);
    VTDecompressionSessionInvalidate(d->vt);
    CFRelease(d->vt);
    CFRelease(d->vt_format);
    pthread_mutex_destroy(&d->lock);
    pthread_cond_destroy(&d->arrived);
  }

  sws_freeContext(d->sws);
  av_frame_free(&d->sw);
  av_frame_free(&d->frame);
  av_packet_free(&d->pkt);
  avcodec_free_context(&d->ctx);
  av_buffer_unref(&d->hw);
  avformat_close_input(&d->fmt);
  av_free(d);
}

static void vt_output(void *ref, void *frame_ref, OSStatus status, VTDecodeInfoFlags flags, CVImageBufferRef image, CMTime pts, CMTime duration) {
  otd *d = ref;
  pthread_mutex_lock(&d->lock);
  d->in_flight--;
  if (status != noErr && d->vt_status == noErr) d->vt_status = status;
  if (status == noErr && image && !(flags & kVTDecodeInfo_FrameDropped) && d->outs < 64) {
    d->out_buf[d->outs] = CVPixelBufferRetain(image);
    d->out_pts[d->outs++] = CMTimeGetSeconds(pts);
  }
  pthread_cond_signal(&d->arrived);
  pthread_mutex_unlock(&d->lock);
}

// A VTDecompressionSession for the stream, described by its avcC/hvcC (MP4's sample description) as FFmpeg does; 0 if VideoToolbox can't decode it.
static int vt_open(otd *d, AVCodecParameters *par) {
  CMVideoCodecType type;
  CFStringRef atom;
  if (par->codec_id == AV_CODEC_ID_H264) type = kCMVideoCodecType_H264, atom = CFSTR("avcC");
  else if (par->codec_id == AV_CODEC_ID_HEVC) type = kCMVideoCodecType_HEVC, atom = CFSTR("hvcC");
  else return 0;
  if (!par->extradata_size || par->extradata[0] != 1) return 0;
  CFDataRef data = CFDataCreate(NULL, par->extradata, par->extradata_size);
  CFDictionaryRef atoms = CFDictionaryCreate(NULL, (const void **)&atom, (const void **)&data, 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  const void *key = kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms;
  CFDictionaryRef ext = CFDictionaryCreate(NULL, &key, (const void **)&atoms, 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  OSStatus s = CMVideoFormatDescriptionCreate(NULL, type, par->width, par->height, ext, &d->vt_format);
  CFRelease(ext);
  CFRelease(atoms);
  CFRelease(data);
  if (s != noErr) return 0;
  const void *spec_key = kVTVideoDecoderSpecification_RequireHardwareAcceleratedVideoDecoder;
  CFDictionaryRef spec = CFDictionaryCreate(NULL, &spec_key, (const void **)&kCFBooleanTrue, 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  // Left to itself VideoToolbox hands 4:2:2 and 4:4:4 sources back in formats vt_view can't read, so
  // 4:2:0 is asked for: 10-bit when hvcC's bitDepthLumaMinus8 says so (VideoToolbox has no 10-bit H.264).
  int deep = par->codec_id == AV_CODEC_ID_HEVC && par->extradata_size > 18 && (par->extradata[18] & 7);
  int full = par->color_range == AVCOL_RANGE_JPEG;
  int32_t pixels = deep ? (full ? kCVPixelFormatType_420YpCbCr10BiPlanarFullRange : kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange)
                        : (full ? kCVPixelFormatType_420YpCbCr8BiPlanarFullRange : kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange);
  CFNumberRef pixels_num = CFNumberCreate(NULL, kCFNumberSInt32Type, &pixels);
  // Metal compatible (IOSurface backed), so the renderer can sample the planes where they are (otd_surface).
  const void *dest_keys[] = {kCVPixelBufferPixelFormatTypeKey, kCVPixelBufferMetalCompatibilityKey};
  const void *dest_values[] = {pixels_num, kCFBooleanTrue};
  CFDictionaryRef dest = CFDictionaryCreate(NULL, dest_keys, dest_values, 2, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  VTDecompressionOutputCallbackRecord cb = {vt_output, d};
  s = VTDecompressionSessionCreate(NULL, d->vt_format, spec, dest, &cb, &d->vt);
  CFRelease(dest);
  CFRelease(pixels_num);
  CFRelease(spec);
  if (s != noErr) {
    CFRelease(d->vt_format);
    d->vt_format = NULL;
    d->vt = NULL;
    return 0;
  }
  pthread_mutex_init(&d->lock, NULL);
  d->key_pts = INT64_MIN;
  pthread_cond_init(&d->arrived, NULL);
  d->reorder = FFMIN(FFMAX(par->video_delay, REORDER), 64 - IN_FLIGHT - 1);
  return 1;
}

static void release_pixels(void *opaque, uint8_t *data) {
  CVPixelBufferRelease((CVPixelBufferRef)data);
}

// The next frame in display order: packets are sent ahead (IN_FLIGHT at once) while `reorder` decoded ones wait.
static int vt_next(otd *d, double *pts) {
  for (;;) {
    pthread_mutex_lock(&d->lock);
    if (d->vt_status != noErr) {
      pthread_mutex_unlock(&d->lock);
      return AVERROR(EIO);
    }
    if (d->outs > d->reorder || (d->vt_eof && d->outs)) {
      int best = 0;
      for (int i = 1; i < d->outs; i++)
        if (d->out_pts[i] < d->out_pts[best]) best = i;
      CVPixelBufferRef buf = d->out_buf[best];
      *pts = d->out_pts[best];
      d->outs--;
      d->out_buf[best] = d->out_buf[d->outs];
      d->out_pts[best] = d->out_pts[d->outs];
      pthread_mutex_unlock(&d->lock);
      av_frame_unref(d->frame);
      d->frame->format = AV_PIX_FMT_VIDEOTOOLBOX;
      d->frame->width = (int)CVPixelBufferGetWidth(buf);
      d->frame->height = (int)CVPixelBufferGetHeight(buf);
      d->frame->data[3] = (uint8_t *)buf;
      d->frame->buf[0] = av_buffer_create((uint8_t *)buf, 1, release_pixels, NULL, AV_BUFFER_FLAG_READONLY);
      if (!d->frame->buf[0]) {
        CVPixelBufferRelease(buf);
        d->frame->data[3] = NULL;
        return AVERROR(ENOMEM);
      }
      return 0;
    }
    if (d->vt_eof) {
      pthread_mutex_unlock(&d->lock);
      return 1;
    }
    while (d->in_flight >= IN_FLIGHT) pthread_cond_wait(&d->arrived, &d->lock);
    pthread_mutex_unlock(&d->lock);
    int r;
    do {
      r = av_read_frame(d->fmt, d->pkt);
      if (r >= 0 && d->pkt->stream_index != d->stream) av_packet_unref(d->pkt), r = 1;
    } while (r == 1);
    if (r == AVERROR_EOF) {
      VTDecompressionSessionFinishDelayedFrames(d->vt);
      VTDecompressionSessionWaitForAsynchronousFrames(d->vt);
      pthread_mutex_lock(&d->lock);
      d->vt_eof = 1;
      pthread_mutex_unlock(&d->lock);
      continue;
    }
    if (r < 0) return r;
    AVRational tb = d->fmt->streams[d->stream]->time_base;
    int64_t t = d->pkt->pts != AV_NOPTS_VALUE ? d->pkt->pts : d->pkt->dts;
    if (d->need_key) {
      if (!(d->pkt->flags & AV_PKT_FLAG_KEY)) {
        av_packet_unref(d->pkt);
        continue;
      }
      d->need_key = 0;
      d->key_pts = t;
    } else if (t < d->key_pts) {
      av_packet_unref(d->pkt);
      continue;
    }
    CMSampleTimingInfo timing = {kCMTimeInvalid, CMTimeMake(t * tb.num, tb.den), kCMTimeInvalid};
    size_t size = d->pkt->size;
    CMBlockBufferRef block = NULL;
    CMSampleBufferRef sample = NULL;
    OSStatus s = CMBlockBufferCreateWithMemoryBlock(NULL, NULL, size, NULL, NULL, 0, size, kCMBlockBufferAssureMemoryNowFlag, &block);
    if (s == noErr) s = CMBlockBufferReplaceDataBytes(d->pkt->data, block, 0, size);
    if (s == noErr) s = CMSampleBufferCreateReady(NULL, block, d->vt_format, 1, 1, &timing, 1, &size, &sample);
    av_packet_unref(d->pkt);
    if (block) CFRelease(block);
    if (s != noErr) return AVERROR(EIO);
    pthread_mutex_lock(&d->lock);
    d->in_flight++;
    pthread_mutex_unlock(&d->lock);
    s = VTDecompressionSessionDecodeFrame(d->vt, sample, kVTDecodeFrame_EnableAsynchronousDecompression, NULL, NULL);
    CFRelease(sample);
    if (s != noErr) {
      pthread_mutex_lock(&d->lock);
      d->in_flight--;
      pthread_mutex_unlock(&d->lock);
    }
  }
}

// A natively decoded frame's planes, seen as an FFmpeg software frame (no copy) while `buf` stays locked; 0 if its format isn't one FFmpeg's VideoToolbox path produces.
static int vt_view(CVPixelBufferRef buf, AVFrame *f) {
  OSType type = CVPixelBufferGetPixelFormatType(buf);
  if (type == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange || type == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange) f->format = AV_PIX_FMT_NV12;
  else if (type == kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange || type == kCVPixelFormatType_420YpCbCr10BiPlanarFullRange) f->format = AV_PIX_FMT_P010;
  else return 0;
  f->width = (int)CVPixelBufferGetWidth(buf);
  f->height = (int)CVPixelBufferGetHeight(buf);
  f->color_range = type == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange || type == kCVPixelFormatType_420YpCbCr10BiPlanarFullRange ? AVCOL_RANGE_JPEG : AVCOL_RANGE_MPEG;
  for (int i = 0; i < 2; i++) {
    f->data[i] = CVPixelBufferGetBaseAddressOfPlane(buf, i);
    f->linesize[i] = (int)CVPixelBufferGetBytesPerRowOfPlane(buf, i);
  }
  return 1;
}

// `nth`: the nth video stream of the file. `hw`: an otd_mode; OTD_HARDWARE decodes H.264/HEVC/ProRes with VideoToolbox as FFmpeg does, OTD_NATIVE natively (H.264/HEVC; others as OTD_HARDWARE).
otd *otd_open(const char *path, int nth, int hw, int threads, char *err, int errlen) {
  av_log_set_level(AV_LOG_ERROR);
  otd *d = av_mallocz(sizeof *d);
  int r;
  AVDictionary *opts = NULL;
  av_dict_set(&opts, "protocol_whitelist", "file", 0);
  if ((r = avformat_open_input(&d->fmt, path, NULL, &opts)) < 0) {
    av_dict_free(&opts);
    say(err, errlen, "open", r);
    otd_close(d);
    return NULL;
  }
  av_dict_free(&opts);
  // MP4/MOV headers already describe each stream; probing decodes frames (~150 ms on a 4K stream).
  int described = 1;
  for (unsigned i = 0; i < d->fmt->nb_streams; i++) {
    AVCodecParameters *par = d->fmt->streams[i]->codecpar;
    if (par->codec_type == AVMEDIA_TYPE_VIDEO && (par->width <= 0 || par->codec_id == AV_CODEC_ID_NONE)) described = 0;
  }
  if (!described && (r = avformat_find_stream_info(d->fmt, NULL)) < 0) {
    say(err, errlen, "stream info", r);
    otd_close(d);
    return NULL;
  }
  d->stream = -1;
  for (unsigned i = 0, n = 0; i < d->fmt->nb_streams; i++) {
    if (d->fmt->streams[i]->codecpar->codec_type != AVMEDIA_TYPE_VIDEO) continue;
    if ((int)n++ == nth) d->stream = i;
  }
  if (d->stream < 0) {
    say(err, errlen, "no such video stream", 0);
    otd_close(d);
    return NULL;
  }
  for (unsigned i = 0; i < d->fmt->nb_streams; i++)
    if ((int)i != d->stream) d->fmt->streams[i]->discard = AVDISCARD_ALL;
  AVStream *st = d->fmt->streams[d->stream];
  d->time_base = av_q2d(st->time_base);
  if (hw == OTD_NATIVE && vt_open(d, st->codecpar)) {
    d->pkt = av_packet_alloc();
    d->frame = av_frame_alloc();
    return d;
  }
  const AVCodec *codec = avcodec_find_decoder(st->codecpar->codec_id);
  if (!codec) {
    say(err, errlen, "no decoder", 0);
    otd_close(d);
    return NULL;
  }
  d->ctx = avcodec_alloc_context3(codec);
  avcodec_parameters_to_context(d->ctx, st->codecpar);
  d->ctx->pkt_timebase = st->time_base;
  d->ctx->thread_count = threads;
  if (hw != OTD_SOFTWARE && av_hwdevice_ctx_create(&d->hw, AV_HWDEVICE_TYPE_VIDEOTOOLBOX, NULL, NULL, 0) == 0) {
    d->ctx->hw_device_ctx = av_buffer_ref(d->hw);
    d->ctx->get_format = pick_hw;
  }
  if ((r = avcodec_open2(d->ctx, codec, NULL)) < 0) {
    say(err, errlen, "open decoder", r);
    otd_close(d);
    return NULL;
  }
  d->pkt = av_packet_alloc();
  d->frame = av_frame_alloc();
  d->sw = av_frame_alloc();
  return d;
}

// Seeks to the keyframe at or before `seconds`; frames then come from there.
int otd_seek(otd *d, double seconds) {
  int64_t ts = (int64_t)(seconds / d->time_base);
  int r = av_seek_frame(d->fmt, d->stream, ts, AVSEEK_FLAG_BACKWARD);
  if (d->vt) {
    vt_clear(d);
    return r < 0 ? r : 0;
  }
  avcodec_flush_buffers(d->ctx);
  d->draining = 0;
  return r < 0 ? r : 0;
}

// Decodes the next frame; its time in `*pts`. 0: a frame, 1: the end, < 0: an error.
int otd_next(otd *d, double *pts) {
  if (d->vt) return vt_next(d, pts);
  for (;;) {
    int r = avcodec_receive_frame(d->ctx, d->frame);
    if (r == 0) {
      int64_t t = d->frame->best_effort_timestamp;
      *pts = t == AV_NOPTS_VALUE ? -1 : t * d->time_base;
      return 0;
    }
    if (r == AVERROR_EOF) return 1;
    if (r != AVERROR(EAGAIN)) return r;
    if (d->draining) return 1;
    for (;;) {
      r = av_read_frame(d->fmt, d->pkt);
      if (r == AVERROR_EOF) {
        d->draining = 1;
        avcodec_send_packet(d->ctx, NULL);
        break;
      }
      if (r < 0) return r;
      if (d->pkt->stream_index != d->stream) {
        av_packet_unref(d->pkt);
        continue;
      }
      r = avcodec_send_packet(d->ctx, d->pkt);
      av_packet_unref(d->pkt);
      if (r < 0 && r != AVERROR(EAGAIN)) return r;
      break;
    }
  }
}

void otd_size(otd *d, int *width, int *height) {
  AVCodecParameters *par = d->fmt->streams[d->stream]->codecpar;
  *width = d->ctx ? d->ctx->width : par->width;
  *height = d->ctx ? d->ctx->height : par->height;
}

static int otd_convert(otd *d, AVFrame *f, enum AVColorSpace space, int full, uint8_t *out, int width, int height, int stride);

// `f` as RGBA at `width`×`height` (area filter), `stride` bytes a row.
int otd_rgba_of(otd *d, AVFrame *f, uint8_t *out, int width, int height, int stride) {
  // The frame's own matrix and range, as ffmpeg's scale filter reads them (untagged: BT.601).
  enum AVColorSpace space = f->colorspace;
  int full = f->color_range == AVCOL_RANGE_JPEG;
  // A native frame is converted as FFmpeg's VideoToolbox path converts its own (the same decoder made the
  // pixels), so the preview stays identical to export; its matrix is the stream's, as FFmpeg reads it.
  CVPixelBufferRef native = f->format == AV_PIX_FMT_VIDEOTOOLBOX && !f->hw_frames_ctx ? (CVPixelBufferRef)f->data[3] : NULL;
  AVFrame view = {0};
  if (native) {
    CVPixelBufferLockBaseAddress(native, kCVPixelBufferLock_ReadOnly);
    if (!vt_view(native, &view)) {
      CVPixelBufferUnlockBaseAddress(native, kCVPixelBufferLock_ReadOnly);
      return AVERROR(ENOSYS);
    }
    view.colorspace = d->fmt->streams[d->stream]->codecpar->color_space;
    f = &view;
    space = f->colorspace;
    full = f->color_range == AVCOL_RANGE_JPEG;
  }
  int r = otd_convert(d, f, space, full, out, width, height, stride);
  if (native) CVPixelBufferUnlockBaseAddress(native, kCVPixelBufferLock_ReadOnly);
  return r;
}

static int otd_convert(otd *d, AVFrame *f, enum AVColorSpace space, int full, uint8_t *out, int width, int height, int stride) {
  if (f->format == AV_PIX_FMT_VIDEOTOOLBOX) {
    av_frame_unref(d->sw);
    int r = av_hwframe_transfer_data(d->sw, f, 0);
    if (r < 0) return r;
    f = d->sw;
  }
  int key[6] = {f->width, f->height, f->format, width, height, (int)space * 2 + full};
  if (!d->sws || memcmp(key, d->sws_key, sizeof key)) {
    // The matrix is set before the context initialises: its fast paths fix their coefficients then.
    sws_freeContext(d->sws);
    d->sws = sws_alloc_context();
    if (!d->sws) return AVERROR(ENOMEM);
    av_opt_set_int(d->sws, "srcw", f->width, 0);
    av_opt_set_int(d->sws, "srch", f->height, 0);
    av_opt_set_int(d->sws, "src_format", f->format, 0);
    av_opt_set_int(d->sws, "dstw", width, 0);
    av_opt_set_int(d->sws, "dsth", height, 0);
    av_opt_set_int(d->sws, "dst_format", AV_PIX_FMT_RGBA, 0);
    av_opt_set_int(d->sws, "sws_flags", SWS_AREA, 0);
    av_opt_set_int(d->sws, "src_range", full, 0);
    av_opt_set_int(d->sws, "dst_range", 1, 0);
    sws_setColorspaceDetails(d->sws, sws_getCoefficients(space), full, sws_getCoefficients(SWS_CS_DEFAULT), 1, 0, 1 << 16, 1 << 16);
    int r = sws_init_context(d->sws, NULL, NULL);
    if (r < 0) {
      sws_freeContext(d->sws);
      d->sws = NULL;
      return r;
    }
    sws_setColorspaceDetails(d->sws, sws_getCoefficients(space), full, sws_getCoefficients(SWS_CS_DEFAULT), 1, 0, 1 << 16, 1 << 16);
    memcpy(d->sws_key, key, sizeof key);
  }
  uint8_t *dst[4] = {out};
  int dst_stride[4] = {stride};
  int r = sws_scale(d->sws, (const uint8_t *const *)f->data, f->linesize, 0, f->height, dst, dst_stride);
  return r < 0 ? r : 0;
}

// The last decoded frame as RGBA.
int otd_rgba(otd *d, uint8_t *out, int width, int height, int stride) {
  return otd_rgba_of(d, d->frame, out, width, height, stride);
}

// A reference to the last decoded frame, converted later with `otd_rgba_of`; `*bytes`: roughly what it holds.
AVFrame *otd_keep(otd *d, size_t *bytes) {
  AVFrame *f = av_frame_clone(d->frame);
  int fmt = f && f->format == AV_PIX_FMT_VIDEOTOOLBOX ? AV_PIX_FMT_NV12 : f ? f->format : AV_PIX_FMT_NONE;
  int n = f ? av_image_get_buffer_size(fmt, f->width, f->height, 1) : 0;
  *bytes = n > 0 ? (size_t)n : 0;
  return f;
}

// `f`'s (or, NULL, the last frame's) pixel buffer, retained, when VideoToolbox decoded it natively as 8-bit
// NV12; NULL otherwise (those frames go through otd_rgba_of).
CVPixelBufferRef otd_surface(otd *d, AVFrame *f) {
  if (!f) f = d->frame;
  if (f->format != AV_PIX_FMT_VIDEOTOOLBOX || f->hw_frames_ctx || !f->data[3]) return NULL;
  CVPixelBufferRef buf = (CVPixelBufferRef)f->data[3];
  OSType type = CVPixelBufferGetPixelFormatType(buf);
  if (type != kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange && type != kCVPixelFormatType_420YpCbCr8BiPlanarFullRange) return NULL;
  if (!CVPixelBufferGetIOSurface(buf)) return NULL;
  return CVPixelBufferRetain(buf);
}

// The matrix a frame's YCbCr is converted with, as swscale reads the stream (otd_rgba_of): AVColorSpace.
int otd_color_space(otd *d) {
  return d->fmt->streams[d->stream]->codecpar->color_space;
}

void otd_drop(AVFrame *f) {
  av_frame_free(&f);
}
