// PaddleOCR (PP-OCRv5 mobile det + rec) running in-process on ONNX Runtime's CPU provider.
// Kept free of tauri so it builds and tests on any host.
pub mod det;
pub mod engine;
pub mod layout;
pub mod rec;
pub mod service;

pub use engine::{intra_threads, Engine, DET_MODEL, REC_DICT, REC_MODEL};
pub use service::{OcrService, DEFAULT_IDLE_UNLOAD};
