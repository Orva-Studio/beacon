use std::path::{Path, PathBuf};
use std::process::Command;

/// FFmpeg's libraries and headers: `BEACON_FFMPEG_LIB` / `BEACON_FFMPEG_INCLUDE`, else
/// the libraries the `ffmpeg` on PATH links (Homebrew's include folder sits
/// beside them; Nix keeps headers in the matching `-dev` output).
fn ffmpeg() -> (PathBuf, PathBuf) {
    let lib = std::env::var_os("BEACON_FFMPEG_LIB").map(PathBuf::from).unwrap_or_else(|| {
        let which = Command::new("sh").args(["-c", "command -v ffmpeg"]).output().expect("sh");
        let bin = String::from_utf8_lossy(&which.stdout).trim().to_string();
        let otool = Command::new("otool").args(["-L", &bin]).output().expect("otool");
        let text = String::from_utf8_lossy(&otool.stdout);
        let line = text.lines().find(|l| l.contains("libavcodec")).unwrap_or_else(|| panic!("{bin} links no libavcodec; set BEACON_FFMPEG_LIB"));
        Path::new(line.trim().split(' ').next().unwrap()).parent().unwrap().to_path_buf()
    });
    let include = std::env::var_os("BEACON_FFMPEG_INCLUDE").map(PathBuf::from).unwrap_or_else(|| {
        let beside = lib.parent().unwrap().join("include");
        if beside.join("libavcodec").exists() {
            return beside;
        }
        let store = lib.parent().unwrap();
        let name = store.file_name().unwrap().to_string_lossy();
        let stem = name.strip_suffix("-lib").and_then(|n| n.split_once('-').map(|(_, rest)| rest.to_string()));
        let dev = stem.and_then(|stem| {
            std::fs::read_dir(store.parent()?).ok()?.flatten().map(|e| e.path()).find(|p| {
                p.file_name().is_some_and(|f| f.to_string_lossy().ends_with(&format!("-{stem}-dev"))) && p.join("include/libavcodec").exists()
            })
        });
        dev.map(|d| d.join("include")).unwrap_or_else(|| panic!("no FFmpeg headers for {}; set BEACON_FFMPEG_INCLUDE", lib.display()))
    });
    (lib, include)
}

fn main() {
    println!("cargo:rerun-if-changed=src/shim.c");
    println!("cargo:rerun-if-env-changed=BEACON_FFMPEG_LIB");
    println!("cargo:rerun-if-env-changed=BEACON_FFMPEG_INCLUDE");
    let (lib, include) = ffmpeg();
    cc::Build::new().file("src/shim.c").include(&include).opt_level(2).warnings(false).compile("otdecode");
    println!("cargo:rustc-link-search=native={}", lib.display());
    for l in ["avformat", "avcodec", "avutil", "swscale"] {
        println!("cargo:rustc-link-lib=dylib={l}");
    }
    for f in ["VideoToolbox", "CoreMedia", "CoreVideo", "CoreFoundation"] {
        println!("cargo:rustc-link-lib=framework={f}");
    }
}
