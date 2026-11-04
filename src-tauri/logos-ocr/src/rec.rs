// Text recognition (CRNN/SVTR + CTC) pre- and post-processing for PP-OCR rec models
use crate::det::TextBox;
use image::RgbImage;

// Every crop is scaled to this line height
pub const REC_HEIGHT: u32 = 48;
// Narrowest input width (one square); PaddleOCR pads everything to 320, which costs time
// on short UI labels without improving them
const REC_MIN_WIDTH: u32 = REC_HEIGHT;
const REC_MAX_BATCH: usize = 6;
// A crop joins a batch only if padding it to the batch width adds at most 10 %, so batching
// never spends more compute on padding than it saves in per-run overhead
const REC_BATCH_SLACK: f32 = 1.1;
// Results scored below this are treated as noise
pub const REC_MIN_SCORE: f32 = 0.5;

pub fn rec_width(width: u32, height: u32) -> u32 {
    ((REC_HEIGHT as f32 * width as f32 / height.max(1) as f32).ceil() as u32).max(1)
}

// Groups crop indices into batches of similar width: crops sorted by width, at most
// REC_MAX_BATCH per batch, the widest at most REC_BATCH_SLACK times the narrowest.
// Returns (indices, padded width) per batch.
pub fn rec_batches(widths: &[u32]) -> Vec<(Vec<usize>, u32)> {
    let mut order: Vec<usize> = (0..widths.len()).collect();
    order.sort_by_key(|&i| widths[i]);
    let mut batches: Vec<(Vec<usize>, u32)> = Vec::new();
    let mut narrowest = 0;
    for i in order {
        let w = widths[i].max(REC_MIN_WIDTH);
        if let Some((members, width)) = batches.last_mut() {
            // sorted ascending, so the new crop sets the batch width
            if members.len() < REC_MAX_BATCH && w as f32 <= narrowest as f32 * REC_BATCH_SLACK {
                members.push(i);
                *width = w;
                continue;
            }
        }
        narrowest = w;
        batches.push((vec![i], w));
    }
    batches
}

pub fn crop(img: &RgbImage, b: &TextBox) -> RgbImage {
    let x0 = (b.x0.floor() as u32).min(img.width() - 1);
    let y0 = (b.y0.floor() as u32).min(img.height() - 1);
    let x1 = (b.x1.ceil() as u32).clamp(x0 + 1, img.width());
    let y1 = (b.y1.ceil() as u32).clamp(y0 + 1, img.height());
    image::imageops::crop_imm(img, x0, y0, x1 - x0, y1 - y0).to_image()
}

// Writes one crop into slot `n` of an NCHW batch of width `batch_w`: resized to REC_HEIGHT,
// BGR, scaled to [-1, 1], right side left at 0 as padding
pub fn fill_rec_tensor(data: &mut [f32], n: usize, batch_w: u32, crop: &RgbImage) {
    let w = rec_width(crop.width(), crop.height()).min(batch_w);
    let resized =
        image::imageops::resize(crop, w, REC_HEIGHT, image::imageops::FilterType::Triangle);
    let plane = (REC_HEIGHT * batch_w) as usize;
    let base = n * plane * 3;
    for (x, y, px) in resized.enumerate_pixels() {
        let offset = y as usize * batch_w as usize + x as usize;
        for c in 0..3 {
            data[base + c * plane + offset] = (px.0[2 - c] as f32 / 255.0 - 0.5) / 0.5;
        }
    }
}

// Greedy CTC decode of one [steps, classes] probability matrix. Class 0 is the blank,
// class i maps to dict[i - 1]. Returns the text and the mean probability of kept steps.
pub fn ctc_decode(probs: &[f32], classes: usize, dict: &[String]) -> (String, f32) {
    let mut text = String::new();
    let mut score = 0f32;
    let mut kept = 0usize;
    let mut prev = 0usize;
    for step in probs.chunks_exact(classes) {
        let (idx, p) = step
            .iter()
            .enumerate()
            .fold((0usize, f32::MIN), |best, (i, &v)| if v > best.1 { (i, v) } else { best });
        if idx != 0 && idx != prev {
            if let Some(ch) = dict.get(idx - 1) {
                text.push_str(ch);
                score += p;
                kept += 1;
            }
        }
        prev = idx;
    }
    let score = if kept == 0 { 0.0 } else { score / kept as f32 };
    (text, score)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dict() -> Vec<String> {
        ["a", "b", "中", " "].iter().map(|s| s.to_string()).collect()
    }

    fn one_hot(seq: &[usize], classes: usize) -> Vec<f32> {
        let mut v = vec![0.0; seq.len() * classes];
        for (t, &c) in seq.iter().enumerate() {
            v[t * classes + c] = 0.9;
        }
        v
    }

    #[test]
    fn ctc_collapses_repeats_and_drops_blanks() {
        // a a _ a b b _ 中 space b
        let probs = one_hot(&[1, 1, 0, 1, 2, 2, 0, 3, 4, 2], 5);
        let (text, score) = ctc_decode(&probs, 5, &dict());
        assert_eq!(text, "aab中 b");
        assert!((score - 0.9).abs() < 1e-6);
    }

    #[test]
    fn ctc_all_blank_is_empty() {
        let probs = one_hot(&[0, 0, 0], 5);
        assert_eq!(ctc_decode(&probs, 5, &dict()), (String::new(), 0.0));
    }

    #[test]
    fn rec_width_keeps_aspect_ratio() {
        assert_eq!(rec_width(100, 24), 200);
        assert_eq!(rec_width(1, 480), 1);
    }

    #[test]
    fn batches_group_similar_widths_and_respect_caps() {
        let widths = [100, 2000, 300, 50, 400, 380, 390, 395, 398, 399];
        let batches = rec_batches(&widths);
        let all: Vec<usize> = batches.iter().flat_map(|(m, _)| m.clone()).collect();
        assert_eq!(all.len(), widths.len());
        for (members, width) in &batches {
            assert!(members.len() <= REC_MAX_BATCH);
            assert!(*width >= REC_MIN_WIDTH);
            assert!(members.iter().all(|&i| widths[i].max(REC_MIN_WIDTH) <= *width));
            let narrowest = members.iter().map(|&i| widths[i].max(REC_MIN_WIDTH)).min().unwrap();
            assert!(*width as f32 <= narrowest as f32 * REC_BATCH_SLACK);
        }
        // 380..400 share one full batch; the 2000 px line is alone
        assert!(batches.iter().any(|(m, w)| m.len() == 6 && *w == 400));
        assert!(batches.iter().any(|(m, w)| m == &vec![1] && *w == 2000));
    }

    #[test]
    fn crop_stays_inside_image() {
        let img = RgbImage::new(10, 10);
        let c = crop(&img, &TextBox { x0: 8.5, y0: -1.0, x1: 30.0, y1: 3.2 });
        assert_eq!((c.width(), c.height()), (2, 4));
    }
}
