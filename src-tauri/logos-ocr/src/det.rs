// Text detection (DB) pre- and post-processing for PP-OCR det models
use image::RgbImage;

// Longest side fed to the det model; larger screenshots are scaled down
pub const DET_LIMIT_SIDE: u32 = 960;
const DET_THRESH: f32 = 0.3;
const DET_BOX_THRESH: f32 = 0.5;
const DET_UNCLIP_RATIO: f32 = 1.6;
const DET_MIN_SIZE: f32 = 3.0;
const DET_MAX_CANDIDATES: usize = 1000;

// PP-OCR models are trained on BGR images normalised with these per-channel values
const MEAN: [f32; 3] = [0.485, 0.456, 0.406];
const STD: [f32; 3] = [0.229, 0.224, 0.225];

// Axis-aligned text box in source image pixels
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TextBox {
    pub x0: f32,
    pub y0: f32,
    pub x1: f32,
    pub y1: f32,
}

impl TextBox {
    pub fn width(&self) -> f32 {
        self.x1 - self.x0
    }
    pub fn height(&self) -> f32 {
        self.y1 - self.y0
    }
}

fn round32(v: f32) -> u32 {
    (((v / 32.0).round() as u32) * 32).max(32)
}

// Det input size: only shrink (longest side <= limit), never enlarge, then round to multiples of 32
pub fn det_input_size(width: u32, height: u32, limit: u32) -> (u32, u32) {
    let longest = width.max(height) as f32;
    let ratio = if longest > limit as f32 {
        limit as f32 / longest
    } else {
        1.0
    };
    (
        round32(width as f32 * ratio),
        round32(height as f32 * ratio),
    )
}

// NCHW float tensor, BGR channel order
pub fn det_tensor(img: &RgbImage, width: u32, height: u32) -> Vec<f32> {
    let resized;
    let src = if img.width() == width && img.height() == height {
        img
    } else {
        use image::imageops::{resize, FilterType};
        resized = resize(img, width, height, FilterType::Triangle);
        &resized
    };
    let plane = (width * height) as usize;
    let mut data = vec![0f32; plane * 3];
    for (i, px) in src.pixels().enumerate() {
        for c in 0..3 {
            // channel c of the tensor holds B, G, R in turn
            let v = px.0[2 - c] as f32 / 255.0;
            data[c * plane + i] = (v - MEAN[c]) / STD[c];
        }
    }
    data
}

// Connected regions of the thresholded probability map become boxes, scored by the mean
// probability inside their bounding rectangle, expanded (unclipped) like DBNet's post-process
// and mapped back to source pixels. Screenshot text is horizontal, so boxes stay axis-aligned.
pub fn boxes_from_prob(
    prob: &[f32],
    map_w: usize,
    map_h: usize,
    src_w: u32,
    src_h: u32,
) -> Vec<TextBox> {
    let mut visited = vec![false; map_w * map_h];
    let mut stack = Vec::new();
    let mut boxes = Vec::new();
    let scale_x = src_w as f32 / map_w as f32;
    let scale_y = src_h as f32 / map_h as f32;

    for start in 0..map_w * map_h {
        if visited[start] || prob[start] <= DET_THRESH {
            continue;
        }
        visited[start] = true;
        stack.push(start);
        let (mut x0, mut y0, mut x1, mut y1) = (map_w, map_h, 0usize, 0usize);
        while let Some(i) = stack.pop() {
            let (x, y) = (i % map_w, i / map_w);
            x0 = x0.min(x);
            y0 = y0.min(y);
            x1 = x1.max(x);
            y1 = y1.max(y);
            for dy in -1i32..=1 {
                for dx in -1i32..=1 {
                    let (nx, ny) = (x as i32 + dx, y as i32 + dy);
                    if nx < 0 || ny < 0 || nx >= map_w as i32 || ny >= map_h as i32 {
                        continue;
                    }
                    let n = ny as usize * map_w + nx as usize;
                    if !visited[n] && prob[n] > DET_THRESH {
                        visited[n] = true;
                        stack.push(n);
                    }
                }
            }
        }

        let w = (x1 - x0 + 1) as f32;
        let h = (y1 - y0 + 1) as f32;
        if w.min(h) < DET_MIN_SIZE {
            continue;
        }
        let mut sum = 0f32;
        for y in y0..=y1 {
            sum += prob[y * map_w + x0..=y * map_w + x1].iter().sum::<f32>();
        }
        if sum / (w * h) < DET_BOX_THRESH {
            continue;
        }
        let d = w * h * DET_UNCLIP_RATIO / (2.0 * (w + h));
        let (ew, eh) = (w + 2.0 * d, h + 2.0 * d);
        if ew.min(eh) < DET_MIN_SIZE + 2.0 {
            continue;
        }
        let bx = TextBox {
            x0: ((x0 as f32 - d) * scale_x).clamp(0.0, src_w as f32),
            y0: ((y0 as f32 - d) * scale_y).clamp(0.0, src_h as f32),
            x1: ((x1 as f32 + 1.0 + d) * scale_x).clamp(0.0, src_w as f32),
            y1: ((y1 as f32 + 1.0 + d) * scale_y).clamp(0.0, src_h as f32),
        };
        if bx.width() >= 1.0 && bx.height() >= 1.0 {
            boxes.push(bx);
        }
        if boxes.len() >= DET_MAX_CANDIDATES {
            break;
        }
    }
    boxes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn det_size_shrinks_large_images_and_keeps_small_ones() {
        assert_eq!(det_input_size(1920, 1080, 960), (960, 544));
        assert_eq!(det_input_size(300, 40, 960), (288, 32));
        // never below one 32 px stride
        assert_eq!(det_input_size(10, 5, 960), (32, 32));
    }

    #[test]
    fn regions_become_unclipped_scaled_boxes() {
        let (w, h) = (20usize, 10usize);
        let mut prob = vec![0f32; w * h];
        // a 10x4 block of text at (2..12, 3..7)
        for y in 3..7 {
            for x in 2..12 {
                prob[y * w + x] = 0.9;
            }
        }
        // a lone noisy pixel is dropped by the min-size check
        prob[9 * w + 18] = 0.9;
        let boxes = boxes_from_prob(&prob, w, h, 40, 20);
        assert_eq!(boxes.len(), 1);
        let b = boxes[0];
        // d = 10*4*1.6 / (2*14) ~= 2.29 map px, doubled by the 2x scale
        assert!((b.x0 - 0.0).abs() < 1e-3, "{b:?}");
        assert!((b.y0 - (3.0 - 2.2857) * 2.0).abs() < 1e-3, "{b:?}");
        assert!((b.x1 - (12.0 + 2.2857) * 2.0).abs() < 1e-3, "{b:?}");
        assert!((b.y1 - (7.0 + 2.2857) * 2.0).abs() < 1e-3, "{b:?}");
    }

    #[test]
    fn low_score_regions_are_dropped() {
        let (w, h) = (10usize, 10usize);
        let mut prob = vec![0f32; w * h];
        for y in 2..8 {
            for x in 2..8 {
                prob[y * w + x] = 0.35;
            }
        }
        assert!(boxes_from_prob(&prob, w, h, 10, 10).is_empty());
    }

    #[test]
    fn det_tensor_is_bgr_and_normalised() {
        let img = RgbImage::from_pixel(32, 32, image::Rgb([255, 0, 0]));
        let t = det_tensor(&img, 32, 32);
        let plane = 32 * 32;
        // channel 0 is blue (0), channel 2 is red (255)
        assert!((t[0] - (0.0 - MEAN[0]) / STD[0]).abs() < 1e-5);
        assert!((t[2 * plane] - (1.0 - MEAN[2]) / STD[2]).abs() < 1e-5);
    }
}
