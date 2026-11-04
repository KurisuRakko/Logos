// Model lifetime: nothing is loaded until first needed (or preloaded when a screenshot starts),
// and the sessions are dropped again after a period without use
use crate::engine::Engine;
use image::RgbImage;
use log::{error, info};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

pub const DEFAULT_IDLE_UNLOAD: Duration = Duration::from_secs(180);

struct State {
    engine: Option<Engine>,
    last_used: Instant,
    // an unload thread is waiting for the idle deadline
    reaper: bool,
}

pub struct OcrService {
    state: Mutex<State>,
    idle_unload: Duration,
}

impl OcrService {
    pub fn new(idle_unload: Duration) -> OcrService {
        OcrService {
            state: Mutex::new(State {
                engine: None,
                last_used: Instant::now(),
                reaper: false,
            }),
            idle_unload,
        }
    }

    // A panic during recognition must not disable OCR for the rest of the session
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn is_loaded(&self) -> bool {
        self.lock().engine.is_some()
    }

    // Starts loading in a background thread and returns at once. A recognition request that
    // arrives meanwhile waits on the same lock instead of loading a second copy.
    pub fn preload(&'static self, model_dir: PathBuf) {
        let spawned = std::thread::Builder::new()
            .name("paddle-ocr-preload".into())
            .spawn(move || {
                let mut state = self.lock();
                if let Err(e) = self.ensure_loaded(&mut state, &model_dir) {
                    error!("PaddleOCR preload failed: {e}");
                }
            });
        if let Err(e) = spawned {
            error!("PaddleOCR preload thread failed: {e}");
        }
    }

    pub fn recognize(&'static self, model_dir: &Path, img: &RgbImage) -> Result<String, String> {
        let mut state = self.lock();
        self.ensure_loaded(&mut state, model_dir)?;
        let result = state.engine.as_mut().unwrap().ocr(img);
        state.last_used = Instant::now();
        result
    }

    fn ensure_loaded(&'static self, state: &mut State, model_dir: &Path) -> Result<(), String> {
        state.last_used = Instant::now();
        if state.engine.is_none() {
            state.engine = Some(Engine::load(model_dir)?);
        }
        if !state.reaper {
            state.reaper = true;
            let spawned = std::thread::Builder::new()
                .name("paddle-ocr-unload".into())
                .spawn(move || self.unload_when_idle());
            if spawned.is_err() {
                state.reaper = false;
            }
        }
        Ok(())
    }

    // Sleeps until the idle deadline, re-checking after each use pushes it back
    fn unload_when_idle(&self) {
        loop {
            let wait = {
                let mut state = self.lock();
                let idle = state.last_used.elapsed();
                if idle >= self.idle_unload {
                    state.engine = None;
                    state.reaper = false;
                    info!("PaddleOCR unloaded after {} s idle", idle.as_secs());
                    return;
                }
                self.idle_unload - idle
            };
            std::thread::sleep(wait);
        }
    }
}
