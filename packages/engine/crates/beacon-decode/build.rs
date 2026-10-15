use std::path::{Path, PathBuf};

/// Beacon's own FFmpeg (`bun run build:tools`, in `third-party/out`), or `BEACON_FFMPEG_LIB` /
/// `BEACON_FFMPEG_INCLUDE`. Never the one on PATH: the app ships the libraries it was built against.
fn ffmpeg() -> (PathBuf, PathBuf, PathBuf) {
    let out = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../third-party/out");
    let lib = std::env::var_os("BEACON_FFMPEG_LIB").map(PathBuf::from).unwrap_or_else(|| out.join("lib"));
    let include = std::env::var_os("BEACON_FFMPEG_INCLUDE").map(PathBuf::from).unwrap_or_else(|| out.join("include"));
    if !include.join("libavcodec").exists() {
        panic!("no FFmpeg headers in {}: run `bun run build:tools` (or set BEACON_FFMPEG_INCLUDE/BEACON_FFMPEG_LIB)", include.display());
    }
    (lib, include, out.join("bin"))
}

fn main() {
    println!("cargo:rerun-if-changed=src/shim.c");
    println!("cargo:rerun-if-env-changed=BEACON_FFMPEG_LIB");
    println!("cargo:rerun-if-env-changed=BEACON_FFMPEG_INCLUDE");
    let (lib, include, bin) = ffmpeg();
    println!("cargo:rerun-if-changed={}", lib.display());
    println!("cargo:rustc-env=BEACON_TOOLS_BUILD_DIR={}", bin.canonicalize().unwrap_or(bin).display());
    cc::Build::new().file("src/shim.c").include(&include).opt_level(2).warnings(false).compile("otdecode");
    println!("cargo:rustc-link-search=native={}", lib.display());
    for l in ["avformat", "avcodec", "avutil", "swscale"] {
        println!("cargo:rustc-link-lib=dylib={l}");
    }
    for f in ["VideoToolbox", "CoreMedia", "CoreVideo", "CoreFoundation"] {
        println!("cargo:rustc-link-lib=framework={f}");
    }
}
