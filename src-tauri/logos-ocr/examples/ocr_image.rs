// Runs the full pipeline on one image and prints timings.
// cargo run -p logos-ocr --release --example ocr_image -- <image> [model_dir] [runs]
use logos_ocr::Engine;
use std::path::PathBuf;
use std::time::Instant;

// VmRSS / VmHWM from /proc (Linux only)
fn memory(label: &str) {
    if let Ok(status) = std::fs::read_to_string("/proc/self/status") {
        let field = |name: &str| {
            status
                .lines()
                .find(|l| l.starts_with(name))
                .map(|l| l[name.len()..].trim().to_string())
                .unwrap_or_default()
        };
        println!("{label}: rss {}, peak {}", field("VmRSS:"), field("VmHWM:"));
    }
}

fn main() {
    let mut args = std::env::args().skip(1);
    let image_path = args.next().expect("usage: ocr_image <image> [model_dir] [runs]");
    let model_dir = args.next().map(PathBuf::from).unwrap_or_else(|| {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources/paddle-ocr")
    });
    let runs: usize = args.next().map(|v| v.parse().unwrap()).unwrap_or(5);

    let img = image::open(&image_path).expect("open image").into_rgb8();
    println!("image: {}x{}", img.width(), img.height());
    println!("intra-op threads: {}, inter-op threads: 1", logos_ocr::intra_threads());

    memory("before load");
    let start = Instant::now();
    let mut engine = Engine::load(&model_dir).expect("load models");
    println!("cold load: {} ms", start.elapsed().as_millis());

    let start = Instant::now();
    let text = engine.ocr(&img).expect("ocr");
    println!("first recognition: {} ms", start.elapsed().as_millis());

    let start = Instant::now();
    for _ in 0..runs {
        engine.ocr(&img).expect("ocr");
    }
    if runs > 0 {
        println!(
            "warm recognition: {} ms (mean of {runs})",
            start.elapsed().as_millis() / runs as u128
        );
    }
    memory("after recognition");
    drop(engine);
    memory("after unload");
    #[cfg(target_os = "linux")]
    {
        // glibc keeps freed heap pages; trimming shows what the engine actually released
        extern "C" {
            fn malloc_trim(pad: usize) -> i32;
        }
        unsafe { malloc_trim(0) };
        memory("after unload + malloc_trim");
    }
    println!("----\n{text}\n----");
}
