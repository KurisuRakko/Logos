// Han, kana, Hangul and CJK / full-width punctuation: lines between these join without a space
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿＀-￯]/u;
const LOWERCASE = /\p{Ll}/u;

// Merge the lines of recognized text into one paragraph, joining each pair of lines by script
export function joinRecognizedLines(text) {
    const lines = text
        .split(/\r?\n/)
        .map((line) => line.replace(/\s+/g, ' ').trim())
        .filter((line) => line !== '');
    let result = lines[0] ?? '';
    for (const line of lines.slice(1)) {
        const last = result[result.length - 1];
        const first = line[0];
        if (last === '-' && LOWERCASE.test(first)) {
            // a word hyphenated across the line break
            result = result.slice(0, -1) + line;
        } else if (CJK.test(last) && CJK.test(first)) {
            result += line;
        } else {
            result += ' ' + line;
        }
    }
    return result;
}
