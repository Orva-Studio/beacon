#!/usr/bin/env bun
/**
 * Builds the command-line tools Beacon ships inside the app (PLAN §13, Phase 6.5), from pinned sources:
 * a minimal FFmpeg (ffmpeg, ffprobe and the shared libraries beacon-decode links), LGPL only, with libvpx
 * and Opus for WebM, LAME for MP3, whisper.cpp's whisper-cli with Metal, and beacon-speech (Apple's on-device transcriber,
 * packages/engine/speech). Output: packages/engine/third-party/out.
 * Needs pkg-config and cmake (`nix shell nixpkgs#pkg-config nixpkgs#cmake`, or Homebrew's).
 *
 *   bun run build:tools                 builds what is out of date
 *   bun run build:tools --force         builds everything again
 *   bun run build:tools --sources dir   writes what a release attaches for FFmpeg's LGPL: its source as
 *                                       downloaded, the change to its configure as a patch, and the options
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { foreignLinks } from "./macho";

const ROOT = join(import.meta.dir, "../packages/engine/third-party");
const SRC = join(ROOT, "src");
const BUILD = join(ROOT, "build");
/** Static libvpx, Opus and LAME, linked into libavcodec. */
const DEPS = join(ROOT, "deps");
export const OUT = join(ROOT, "out");
const MACOS = "14.0";
const JOBS = String(navigator.hardwareConcurrency);

interface Source {
  name: string;
  url: string;
  sha256: string;
}
// FFmpeg's tarball is signed by its release key (FCF9 86EA 15E6 E293 A564 4F10 B432 2F04 D676 58D8), Opus's
// hash is Xiph's SHA256SUMS, LAME's the one Homebrew and Debian pin; libvpx and whisper.cpp are GitHub tag
// archives, pinned as first fetched.
const FFMPEG: Source = { name: "ffmpeg-7.1.3", url: "https://ffmpeg.org/releases/ffmpeg-7.1.3.tar.xz", sha256: "f0bf043299db9e3caacb435a712fc541fbb07df613c4b893e8b77e67baf3adbe" };
const VPX: Source = { name: "libvpx-1.15.2", url: "https://github.com/webmproject/libvpx/archive/refs/tags/v1.15.2.tar.gz", sha256: "26fcd3db88045dee380e581862a6ef106f49b74b6396ee95c2993a260b4636aa" };
const OPUS: Source = { name: "opus-1.5.2", url: "https://downloads.xiph.org/releases/opus/opus-1.5.2.tar.gz", sha256: "65c1d2f78b9f2fb20082c38cbe47c951ad5839345876e46941612ee87f9a7ce1" };
const LAME: Source = { name: "lame-3.100", url: "https://downloads.sourceforge.net/project/lame/lame/3.100/lame-3.100.tar.gz", sha256: "ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e" };
const WHISPER: Source = { name: "whisper.cpp-1.9.2", url: "https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v1.9.2.tar.gz", sha256: "a6abd064fcca8b85e794d205abf328c522e9451db43a3eadc178b883b7d0e9cd" };

/** What Beacon's ffmpeg can do: only what it uses (docs/dependencies.md lists the libraries). */
const ENABLE = {
  protocol: ["file", "pipe", "fd"],
  demuxer: ["mov", "matroska", "avi", "mp3", "aac", "wav", "flac", "ogg", "gif", "image2", "image_png_pipe", "image_jpeg_pipe", "image_webp_pipe", "image_bmp_pipe", "image_tiff_pipe", "rawvideo", "pcm_s16le", "pcm_f32le"],
  muxer: ["mov", "mp4", "ipod", "matroska", "matroska_audio", "webm", "gif", "image2", "image2pipe", "rawvideo", "null", "wav", "mp3", "adts", "pcm_s16le", "pcm_f32le"],
  decoder: [
    "tscc2", "h264", "hevc", "prores", "mpeg4", "vp8", "vp9", "mjpeg", "png", "gif", "webp", "bmp", "tiff", "rawvideo",
    "aac", "mp3float", "alac", "flac", "opus", "vorbis", "pcm_s16le", "pcm_s16be", "pcm_s24le", "pcm_s24be", "pcm_s32le", "pcm_f32le", "pcm_f32be", "pcm_u8",
  ],
  encoder: ["wrapped_avframe", "h264_videotoolbox", "hevc_videotoolbox", "prores_videotoolbox", "libvpx_vp9", "png", "gif", "rawvideo", "aac", "libopus", "libmp3lame", "pcm_s16le", "pcm_f32le"],
  hwaccel: ["h264_videotoolbox", "hevc_videotoolbox", "prores_videotoolbox", "vp9_videotoolbox"],
  parser: ["h264", "hevc", "aac", "mpegaudio", "opus", "vorbis", "flac", "vp8", "vp9", "png", "mjpeg", "gif", "webp", "bmp"],
  bsf: ["h264_mp4toannexb", "hevc_mp4toannexb", "aac_adtstoasc", "vp9_superframe", "extract_extradata", "null"],
  filter: [
    "buffer", "abuffer", "buffersink", "abuffersink", "null", "anull", "copy", "acopy", "format", "aformat", "aresample",
    "scale", "scale_vt", "setparams", "fps", "split", "palettegen", "paletteuse", "signalstats", "metadata",
    "transpose", "transpose_vt", "hflip", "vflip", "rotate", "hwdownload", "hwupload",
    "volume", "atempo", "adelay", "amix", "apad", "anullsrc", "ebur128", "volumedetect",
    "afftdn", "asendcmd", "concat", "asetpts", "atrim",
  ],
};

const FFMPEG_FLAGS = [
  "--disable-everything", "--disable-autodetect", "--disable-doc", "--disable-network", "--disable-debug", "--disable-static", "--enable-shared",
  "--disable-avdevice", "--disable-postproc", "--disable-ffplay", "--enable-ffmpeg", "--enable-ffprobe",
  "--enable-avfilter", "--enable-swresample", "--enable-swscale", "--enable-videotoolbox", "--enable-audiotoolbox", "--enable-zlib",
  "--enable-libvpx", "--enable-libopus", "--enable-libmp3lame", "--enable-pthreads",
  ...Object.entries(ENABLE).map(([kind, list]) => `--enable-${kind}=${list.join(",")}`),
];

const stamp = (what: string, ...parts: unknown[]) => createHash("sha256").update(JSON.stringify([what, MACOS, ...parts])).digest("hex");
const stampFile = (what: string) => join(OUT, `.${what}.stamp`);
const force = process.argv.includes("--force");
const fresh = (what: string, s: string) => !force && existsSync(stampFile(what)) && readFileSync(stampFile(what), "utf8") === s;

async function fetchSource(s: Source): Promise<string> {
  mkdirSync(SRC, { recursive: true });
  const archive = join(SRC, `${s.name}${s.url.endsWith(".tar.xz") ? ".tar.xz" : ".tar.gz"}`);
  if (!existsSync(archive)) await $`curl -fsSL ${s.url} -o ${archive}`;
  const sum = createHash("sha256").update(readFileSync(archive)).digest("hex");
  if (sum !== s.sha256) {
    rmSync(archive);
    throw new Error(`${s.name}: sha256 ${sum}, expected ${s.sha256}`);
  }
  const dir = join(BUILD, s.name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  await $`tar xf ${archive} -C ${dir} --strip-components 1`;
  return dir;
}

const env = { ...process.env, MACOSX_DEPLOYMENT_TARGET: MACOS, PKG_CONFIG_LIBDIR: join(DEPS, "lib/pkgconfig"), PKG_CONFIG_PATH: "" };
const cflags = `-mmacosx-version-min=${MACOS} -O2`;

/** 7.1.3's configure forgets that the metadata filter (its `file=` output) needs libavformat, as fsync's does. */
function changeConfigure(text: string): string {
  const fsync = `enabled fsync_filter        && prepend avfilter_deps "avformat"`;
  if (!text.includes(fsync)) throw new Error("ffmpeg's configure changed: check the metadata filter's libavformat dependency");
  return text.replace(fsync, `${fsync}\nenabled metadata_filter     && prepend avfilter_deps "avformat"`);
}

const configureArgs = (prefix: string) => [
  `--prefix=${prefix}`,
  ...FFMPEG_FLAGS,
  "--pkg-config=pkg-config",
  // LAME has no pkg-config file: its static library and headers are found in the prefix.
  `--extra-cflags=${cflags} -I${join(DEPS, "include")}`,
  // Headers padded so the app's bundling can point the libraries at @rpath (scripts/bundle-tools.ts).
  `--extra-ldflags=-mmacosx-version-min=${MACOS} -Wl,-headerpad_max_install_names -L${join(DEPS, "lib")}`,
];

/** FFmpeg's source as downloaded, the configure change as a patch, and the configure options, into `to`. */
async function releaseSources(to: string) {
  mkdirSync(to, { recursive: true });
  const ff = await fetchSource(FFMPEG);
  copyFileSync(join(SRC, `${FFMPEG.name}.tar.xz`), join(to, `${FFMPEG.name}.tar.xz`));
  // LAME is LGPL too and linked into libavcodec: its source as downloaded goes with FFmpeg's.
  rmSync(await fetchSource(LAME), { recursive: true, force: true });
  copyFileSync(join(SRC, `${LAME.name}.tar.gz`), join(to, `${LAME.name}.tar.gz`));
  const configure = join(ff, "configure");
  writeFileSync(`${configure}.changed`, changeConfigure(readFileSync(configure, "utf8")));
  // diff exits 1 when the files differ, which they must.
  const patch = await $`diff -u -L a/configure -L b/configure configure configure.changed`.cwd(ff).nothrow().text();
  if (!patch.includes("+enabled metadata_filter")) throw new Error("the configure patch is empty");
  writeFileSync(join(to, `${FFMPEG.name}-configure.patch`), patch);
  const options = `# ${FFMPEG.name}, configured on macOS ${MACOS}+ (arm64) with static libvpx, Opus and LAME in the prefix:\n./configure \\\n${configureArgs("<prefix>").map((a) => `  '${a}'`).join(" \\\n")}\n`;
  writeFileSync(join(to, `${FFMPEG.name}-configure-options.txt`), options);
  rmSync(ff, { recursive: true, force: true });
}

async function buildFfmpeg() {
  const s = stamp("ffmpeg", FFMPEG, VPX, OPUS, LAME, FFMPEG_FLAGS);
  if (fresh("ffmpeg", s)) return console.log("ffmpeg: up to date");
  rmSync(DEPS, { recursive: true, force: true });

  const vpx = await fetchSource(VPX);
  console.log(`building ${VPX.name}…`);
  await $`./configure --prefix=${DEPS} --target=arm64-darwin20-gcc --enable-pic --enable-static --disable-shared --enable-vp9 --disable-vp8 --disable-vp9-decoder --disable-examples --disable-tools --disable-docs --disable-unit-tests --extra-cflags=${cflags}`.cwd(vpx).env(env).quiet();
  await $`make -j${JOBS} && make install`.cwd(vpx).env(env).quiet();

  const opus = await fetchSource(OPUS);
  console.log(`building ${OPUS.name}…`);
  await $`./configure --prefix=${DEPS} --enable-static --disable-shared --with-pic --disable-doc --disable-extra-programs CFLAGS=${cflags}`.cwd(opus).env(env).quiet();
  await $`make -j${JOBS} && make install`.cwd(opus).env(env).quiet();

  const lame = await fetchSource(LAME);
  console.log(`building ${LAME.name}…`);
  await $`./configure --prefix=${DEPS} --enable-static --disable-shared --with-pic --disable-frontend --disable-decoder --disable-gtktest CFLAGS=${cflags}`.cwd(lame).env(env).quiet();
  await $`make -j${JOBS} && make install`.cwd(lame).env(env).quiet();

  const ff = await fetchSource(FFMPEG);
  console.log(`building ${FFMPEG.name}…`);
  const configure = join(ff, "configure");
  writeFileSync(configure, changeConfigure(readFileSync(configure, "utf8")));
  for (const d of ["bin", "lib", "include"]) rmSync(join(OUT, d, d === "bin" ? "ffmpeg" : ""), { recursive: d !== "bin", force: true });
  rmSync(join(OUT, "bin", "ffprobe"), { force: true });
  const configured = await $`./configure ${configureArgs(OUT)}`.cwd(ff).env(env).text();
  const license = /License: (.*)/.exec(configured)?.[1];
  if (license !== "LGPL version 2.1 or later") throw new Error(`ffmpeg would be "${license}", not LGPL 2.1`);
  await $`make -j${JOBS} && make install`.cwd(ff).env(env).quiet();
  // Only what was installed stays: the sources hold other projects' tests, which `bun test` would find.
  for (const d of [vpx, opus, lame, ff, DEPS]) rmSync(d, { recursive: true, force: true });
  writeFileSync(stampFile("ffmpeg"), s);
}

const WHISPER_FLAGS = [
  "-DCMAKE_BUILD_TYPE=Release", `-DCMAKE_OSX_DEPLOYMENT_TARGET=${MACOS}`, "-DCMAKE_OSX_ARCHITECTURES=arm64", "-DBUILD_SHARED_LIBS=OFF",
  // Every Apple silicon Mac, not just this one; Metal does the heavy lifting.
  "-DGGML_NATIVE=OFF", "-DGGML_METAL=ON", "-DGGML_METAL_EMBED_LIBRARY=ON", "-DGGML_BLAS=ON",
  "-DWHISPER_BUILD_TESTS=OFF", "-DWHISPER_BUILD_SERVER=OFF", "-DWHISPER_SDL2=OFF", "-DWHISPER_CURL=OFF", "-DWHISPER_FFMPEG=OFF",
];
const whisperStamp = () => stamp("whisper", WHISPER, WHISPER_FLAGS);

async function buildWhisper() {
  const s = whisperStamp();
  if (fresh("whisper", s)) return console.log("whisper-cli: up to date");
  const dir = await fetchSource(WHISPER);
  console.log(`building ${WHISPER.name}…`);
  await $`cmake -S . -B build ${WHISPER_FLAGS}`.cwd(dir).env(env).quiet();
  await $`cmake --build build -j ${JOBS} --target whisper-cli`.cwd(dir).env(env).quiet();
  mkdirSync(join(OUT, "bin"), { recursive: true });
  await $`cp build/bin/whisper-cli ${join(OUT, "bin/whisper-cli")}`.cwd(dir);
  rmSync(dir, { recursive: true, force: true });
  writeFileSync(stampFile("whisper"), s);
}

const SPEECH = join(import.meta.dir, "../packages/engine/speech/beacon-speech.swift");
/** SpeechTranscriber is macOS 26's: this tool alone needs it, so it alone targets 26. */
const SPEECH_FLAGS = ["-O", "-target", "arm64-apple-macosx26.0"];
const speechStamp = () => stamp("speech", readFileSync(SPEECH, "utf8"), SPEECH_FLAGS);

async function buildSpeech() {
  const s = speechStamp();
  if (fresh("speech", s)) return console.log("beacon-speech: up to date");
  console.log("building beacon-speech…");
  mkdirSync(join(OUT, "bin"), { recursive: true });
  await $`xcrun swiftc ${SPEECH_FLAGS} ${SPEECH} -o ${join(OUT, "bin/beacon-speech")}`.quiet();
  writeFileSync(stampFile("speech"), s);
}

/** Nothing built may load a library from Homebrew, Nix or anywhere else this Mac happens to have. */
async function checkLinks() {
  const files = [...readdirSync(join(OUT, "bin")).map((f) => join(OUT, "bin", f)), ...readdirSync(join(OUT, "lib")).filter((f) => f.endsWith(".dylib")).map((f) => join(OUT, "lib", f))];
  for (const file of files) {
    const foreign = await foreignLinks(file, (l) => l.startsWith(join(OUT, "lib") + "/"));
    if (foreign.length) throw new Error(`${file} links ${foreign.join(", ")}`);
  }
}

/** pkg-config and cmake for a build: from PATH, else from Nix when this Mac has it. */
function needTools() {
  const missing = ["pkg-config", "cmake"].filter((t) => !Bun.which(t));
  if (!missing.length) return;
  if (Bun.which("nix") && !process.env.BEACON_IN_NIX_SHELL) {
    const r = Bun.spawnSync(["nix", "shell", "nixpkgs#pkg-config", "nixpkgs#cmake", "-c", process.execPath, import.meta.path, ...process.argv.slice(2)], { stdio: ["inherit", "inherit", "inherit"], env: { ...process.env, BEACON_IN_NIX_SHELL: "1" } });
    process.exit(r.exitCode);
  }
  throw new Error(`building Beacon's tools needs ${missing.join(" and ")} (brew install ${missing.join(" ")})`);
}

const sources = process.argv.indexOf("--sources");
if (import.meta.main && sources > 0) {
  const to = process.argv[sources + 1];
  if (!to) throw new Error("usage: bun run build:tools --sources <dir>");
  await releaseSources(to);
  console.log(`FFmpeg's source, configure patch and options in ${to}`);
} else if (import.meta.main) {
  mkdirSync(OUT, { recursive: true });
  const ffmpegStamp = stamp("ffmpeg", FFMPEG, VPX, OPUS, LAME, FFMPEG_FLAGS);
  if (!fresh("ffmpeg", ffmpegStamp) || !fresh("whisper", whisperStamp())) needTools();
  await buildFfmpeg();
  await buildWhisper();
  await buildSpeech();
  await checkLinks();
  console.log(`tools in ${OUT}`);
}
