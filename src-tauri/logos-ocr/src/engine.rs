// ONNX Runtime sessions for one det + one rec model
use crate::det::{self, TextBox};
use crate::layout;
use crate::rec;
use image::RgbImage;
use log::info;
use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session;
use ort::value::TensorRef;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

pub const DET_MODEL: &str = "ch_PP-OCRv5_det_mobile.onnx";
pub const REC_MODEL: &str = "ch_PP-OCRv5_rec_mobile.onnx";
pub const REC_DICT: &str = "ppocrv5_dict.txt";

// intra-op threads: half the physical cores, at most 4, at least 1
pub fn intra_threads() -> usize {
    (num_cpus::get_physical() / 2).clamp(1, 4)
}

pub struct Engine {
    det: Session,
    rec: Session,
    // index i is class i + 1 of the rec output; the trailing " " is the space class
    dict: Vec<String>,
}

// ONNX Runtime allows one environment per process, so it is created once and kept; it holds no
// thread pool (each session owns its own and frees it on unload) and only forwards warnings
fn environment() -> Result<&'static ort::environment::Environment, String> {
    static ENV: OnceLock<ort::environment::Environment> = OnceLock::new();
    static INIT: Mutex<()> = Mutex::new(());
    let _guard = INIT.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(env) = ENV.get() {
        return Ok(env);
    }
    let env = ort::init()
        .with_name("logos-ocr")
        .with_telemetry(false)
        .with_logger(Arc::new(|level, category, _id, _location, message| {
            use ort::logging::LogLevel;
            match level {
                LogLevel::Warning => log::warn!("onnxruntime [{category}] {message}"),
                LogLevel::Error | LogLevel::Fatal => {
                    log::error!("onnxruntime [{category}] {message}")
                }
                _ => {}
            }
        }))
        .build()
        .map_err(|e| e.to_string())?;
    env.set_log_level(ort::logging::LogLevel::Warning);
    Ok(ENV.get_or_init(|| env))
}

fn session(path: &Path, threads: usize) -> Result<Session, String> {
    let err = |e: ort::Error<_>| e.to_string();
    Session::builder(environment()?)
        .map_err(|e| e.to_string())?
        .with_optimization_level(GraphOptimizationLevel::Level3)
        .map_err(err)?
        .with_intra_threads(threads)
        .map_err(err)?
        .with_inter_threads(1)
        .map_err(err)?
        // idle pool threads block instead of busy-waiting between runs
        .with_intra_op_spinning(false)
        .map_err(err)?
        .with_inter_op_spinning(false)
        .map_err(err)?
        // input shapes change on every call, so pre-planned memory patterns do not help
        .with_memory_pattern(false)
        .map_err(err)?
        // CPU provider only (no GPU / DirectML). Without the arena, freed buffers go back to the
        // allocator after each run: peak memory drops by about a quarter at the same speed.
        .with_execution_providers([ort::ep::CPU::default().with_arena_allocator(false).build()])
        .map_err(err)?
        .commit_from_file(path)
        .map_err(|e| format!("{}: {e}", path.display()))
}

impl Engine {
    pub fn load(model_dir: &Path) -> Result<Engine, String> {
        let start = Instant::now();
        let threads = intra_threads();
        let dict_text = std::fs::read_to_string(model_dir.join(REC_DICT))
            .map_err(|e| format!("{}: {e}", model_dir.join(REC_DICT).display()))?;
        let mut dict: Vec<String> = dict_text
            .lines()
            .map(|l| l.trim_end_matches('\r').to_string())
            .collect();
        dict.push(" ".to_string());
        let engine = Engine {
            det: session(&model_dir.join(DET_MODEL), threads)?,
            rec: session(&model_dir.join(REC_MODEL), threads)?,
            dict,
        };
        info!(
            "PaddleOCR loaded in {} ms ({} intra-op threads)",
            start.elapsed().as_millis(),
            threads
        );
        Ok(engine)
    }

    pub fn detect(&mut self, img: &RgbImage) -> Result<Vec<TextBox>, String> {
        let (w, h) = det::det_input_size(img.width(), img.height(), det::DET_LIMIT_SIDE);
        let data = det::det_tensor(img, w, h);
        let input = TensorRef::from_array_view(([1usize, 3, h as usize, w as usize], &data[..]))
            .map_err(|e| e.to_string())?;
        let outputs = self
            .det
            .run(ort::inputs![input])
            .map_err(|e| e.to_string())?;
        let (shape, prob) = outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(|e| e.to_string())?;
        // [1, 1, H, W]
        let (map_h, map_w) = (shape[2] as usize, shape[3] as usize);
        Ok(det::boxes_from_prob(prob, map_w, map_h, img.width(), img.height()))
    }

    pub fn recognize_boxes(
        &mut self,
        img: &RgbImage,
        boxes: &[TextBox],
    ) -> Result<Vec<(String, f32)>, String> {
        let crops: Vec<RgbImage> = boxes.iter().map(|b| rec::crop(img, b)).collect();
        let widths: Vec<u32> = crops
            .iter()
            .map(|c| rec::rec_width(c.width(), c.height()))
            .collect();
        let mut results = vec![(String::new(), 0f32); crops.len()];
        let mut data = Vec::new();
        for (members, batch_w) in rec::rec_batches(&widths) {
            let plane = (rec::REC_HEIGHT * batch_w) as usize;
            data.clear();
            data.resize(members.len() * 3 * plane, 0f32);
            for (n, &i) in members.iter().enumerate() {
                rec::fill_rec_tensor(&mut data, n, batch_w, &crops[i]);
            }
            let input = TensorRef::from_array_view((
                [members.len(), 3, rec::REC_HEIGHT as usize, batch_w as usize],
                &data[..],
            ))
            .map_err(|e| e.to_string())?;
            let outputs = self
                .rec
                .run(ort::inputs![input])
                .map_err(|e| e.to_string())?;
            let (shape, probs) = outputs[0]
                .try_extract_tensor::<f32>()
                .map_err(|e| e.to_string())?;
            // [N, steps, classes]
            let (steps, classes) = (shape[1] as usize, shape[2] as usize);
            if classes != self.dict.len() + 1 {
                return Err(format!(
                    "Recognition model has {classes} classes but the dictionary has {} entries",
                    self.dict.len()
                ));
            }
            for (n, &i) in members.iter().enumerate() {
                let one = &probs[n * steps * classes..(n + 1) * steps * classes];
                results[i] = rec::ctc_decode(one, classes, &self.dict);
            }
        }
        Ok(results)
    }

    // Full pipeline: detection, recognition, reading-order join
    pub fn ocr(&mut self, img: &RgbImage) -> Result<String, String> {
        // a zero-sized selection has nothing to read and would underflow the crop bounds
        if img.width() == 0 || img.height() == 0 {
            return Ok(String::new());
        }
        let boxes = self.detect(img)?;
        if boxes.is_empty() {
            return Ok(String::new());
        }
        let texts = self.recognize_boxes(img, &boxes)?;
        let items = boxes
            .into_iter()
            .zip(texts)
            .filter(|(_, (_, score))| *score >= rec::REC_MIN_SCORE)
            .map(|(b, (text, _))| (b, text))
            .collect();
        Ok(layout::join_lines(items))
    }
}
