// End-to-end checks against the real models; skipped when they have not been downloaded
// (node scripts/fetch-ocr-models.mjs)
use logos_ocr::OcrService;
use std::path::PathBuf;
use std::time::Duration;

fn model_dir() -> Option<PathBuf> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources/paddle-ocr");
    dir.join(logos_ocr::REC_MODEL).exists().then_some(dir)
}

fn text_image() -> image::RgbImage {
    // "OK" drawn as two thick glyphs is enough to get one detected box
    let mut img = image::RgbImage::from_pixel(160, 64, image::Rgb([255, 255, 255]));
    for (x0, x1) in [(30u32, 36u32), (60, 66), (80, 86)] {
        for y in 16..48 {
            for x in x0..x1 {
                img.put_pixel(x, y, image::Rgb([0, 0, 0]));
            }
        }
    }
    img
}

#[test]
fn loads_lazily_and_unloads_when_idle() {
    let Some(dir) = model_dir() else {
        eprintln!("models not downloaded, skipping");
        return;
    };
    let service: &'static OcrService = Box::leak(Box::new(OcrService::new(Duration::from_secs(1))));
    assert!(!service.is_loaded());

    service.preload(dir.clone());
    // recognize waits for the preload instead of loading twice
    service.recognize(&dir, &text_image()).expect("recognize");
    assert!(service.is_loaded());

    std::thread::sleep(Duration::from_millis(1600));
    assert!(!service.is_loaded(), "engine should be dropped after the idle period");

    // and comes back on the next use
    service.recognize(&dir, &text_image()).expect("recognize after unload");
    assert!(service.is_loaded());
}
