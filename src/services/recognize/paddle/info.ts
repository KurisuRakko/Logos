export const info = {
    name: 'paddle',
    icon: 'logo/paddle.png',
};

// One PP-OCRv5 model covers Simplified Chinese, Traditional Chinese and English;
// other languages are not declared, so the recognize window reports them as unsupported
export enum Language {
    auto = 'auto',
    zh_cn = 'zh_cn',
    zh_tw = 'zh_tw',
    en = 'en',
}
