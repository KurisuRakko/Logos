// Reading order: recognised boxes become lines of text
use crate::det::TextBox;

pub fn is_cjk(c: char) -> bool {
    matches!(
        c as u32,
        0x2E80..=0x2FDF
            | 0x3000..=0x30FF
            | 0x3100..=0x318F
            | 0x31C0..=0x32FF
            | 0x3400..=0x4DBF
            | 0x4E00..=0x9FFF
            | 0xA960..=0xA97F
            | 0xAC00..=0xD7FF
            | 0xF900..=0xFAFF
            | 0xFE10..=0xFE1F
            | 0xFE30..=0xFE4F
            | 0xFF00..=0xFFEF
            | 0x20000..=0x2FA1F
    )
}

// Two boxes are on the same line when their vertical overlap covers at least half of the
// shorter one
fn same_line(a: &TextBox, b: &TextBox) -> bool {
    let overlap = a.y1.min(b.y1) - a.y0.max(b.y0);
    overlap >= 0.5 * a.height().min(b.height())
}

// Sorts boxes top to bottom, groups them into lines and joins each line left to right.
// Neighbouring pieces are joined without a space only when both touching characters are CJK.
pub fn join_lines(mut items: Vec<(TextBox, String)>) -> String {
    items.retain(|(_, text)| !text.trim().is_empty());
    items.sort_by(|a, b| (a.0.y0 + a.0.y1).total_cmp(&(b.0.y0 + b.0.y1)));

    let mut lines: Vec<Vec<(TextBox, String)>> = Vec::new();
    for item in items {
        match lines.last_mut() {
            // compare with the line's last box: lines are built in vertical order
            Some(line) if same_line(&line.last().unwrap().0, &item.0) => line.push(item),
            _ => lines.push(vec![item]),
        }
    }

    lines
        .into_iter()
        .map(|mut line| {
            line.sort_by(|a, b| a.0.x0.total_cmp(&b.0.x0));
            let mut text = String::new();
            for (_, piece) in line {
                let piece = piece.trim();
                if let (Some(last), Some(first)) = (text.chars().last(), piece.chars().next()) {
                    if !(is_cjk(last) && is_cjk(first)) {
                        text.push(' ');
                    }
                }
                text.push_str(piece);
            }
            text
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b(x0: f32, y0: f32, x1: f32, y1: f32) -> TextBox {
        TextBox { x0, y0, x1, y1 }
    }

    fn item(x0: f32, y0: f32, x1: f32, y1: f32, text: &str) -> (TextBox, String) {
        (b(x0, y0, x1, y1), text.to_string())
    }

    #[test]
    fn sorts_top_to_bottom_then_left_to_right() {
        let items = vec![
            item(200.0, 52.0, 300.0, 70.0, "world"),
            item(10.0, 10.0, 100.0, 30.0, "标题"),
            item(10.0, 50.0, 180.0, 72.0, "hello"),
        ];
        assert_eq!(join_lines(items), "标题\nhello world");
    }

    #[test]
    fn spaces_only_between_non_cjk_neighbours() {
        let items = vec![
            item(0.0, 0.0, 40.0, 20.0, "打回的"),
            item(50.0, 1.0, 90.0, 21.0, "Rakko Design"),
            item(100.0, 0.0, 140.0, 20.0, "标准"),
            item(150.0, 0.0, 190.0, 20.0, "文档"),
            item(200.0, 0.0, 240.0, 20.0, "v2"),
        ];
        assert_eq!(join_lines(items), "打回的 Rakko Design 标准文档 v2");
    }

    #[test]
    fn slightly_offset_boxes_stay_on_one_line() {
        // baseline jitter of a few pixels is common between detected pieces
        let items = vec![
            item(120.0, 104.0, 200.0, 126.0, "第二段"),
            item(0.0, 100.0, 110.0, 122.0, "第一段"),
            item(0.0, 140.0, 110.0, 162.0, "下一行"),
        ];
        assert_eq!(join_lines(items), "第一段第二段\n下一行");
    }

    #[test]
    fn empty_pieces_are_skipped() {
        let items = vec![item(0.0, 0.0, 10.0, 10.0, " "), item(20.0, 0.0, 30.0, 10.0, "ok")];
        assert_eq!(join_lines(items), "ok");
    }

    #[test]
    fn is_cjk_covers_han_kana_hangul_and_fullwidth_punctuation() {
        for c in ['汉', 'あ', 'ア', '한', '。', '，'] {
            assert!(is_cjk(c), "{c} should be CJK");
        }
        for c in ['A', 'z', ' ', '-'] {
            assert!(!is_cjk(c), "{c} should not be CJK");
        }
    }
}
