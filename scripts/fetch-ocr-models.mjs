// Downloads the PaddleOCR models bundled as Tauri resources (src-tauri/resources/paddle-ocr).
// The files are not kept in git; CI runs this before building and local builds use it too.
// Sources are RapidOCR's ONNX conversions of the official PP-OCRv5 mobile models, pinned to a
// release tag and checked against SHA-256.
//
// Usage: node scripts/fetch-ocr-models.mjs
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0';
const MODELS = [
    {
        name: 'ch_PP-OCRv5_det_mobile.onnx',
        url: `${BASE}/onnx/PP-OCRv5/det/ch_PP-OCRv5_det_mobile.onnx`,
        sha256: '4d97c44a20d30a81aad087d6a396b08f786c4635742afc391f6621f5c6ae78ae',
    },
    {
        name: 'ch_PP-OCRv5_rec_mobile.onnx',
        url: `${BASE}/onnx/PP-OCRv5/rec/ch_PP-OCRv5_rec_mobile.onnx`,
        sha256: '5825fc7ebf84ae7a412be049820b4d86d77620f204a041697b0494669b1742c5',
    },
    {
        name: 'ppocrv5_dict.txt',
        url: `${BASE}/paddle/PP-OCRv5/rec/ch_PP-OCRv5_rec_mobile/ppocrv5_dict.txt`,
        sha256: 'd1979e9f794c464c0d2e0b70a7fe14dd978e9dc644c0e71f14158cdf8342af1b',
    },
];

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'src-tauri', 'resources', 'paddle-ocr');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function existingMatches(path, expected) {
    try {
        return sha256(await readFile(path)) === expected;
    } catch {
        return false;
    }
}

async function fetchWithRetry(url, attempts = 3) {
    for (let i = 1; ; i++) {
        try {
            const res = await fetch(url, { redirect: 'follow' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return Buffer.from(await res.arrayBuffer());
        } catch (e) {
            if (i >= attempts) throw new Error(`${url}: ${e.message}`);
            console.warn(`Retrying ${url} (${e.message})`);
        }
    }
}

await mkdir(outDir, { recursive: true });
for (const model of MODELS) {
    const path = join(outDir, model.name);
    if (await existingMatches(path, model.sha256)) {
        console.log(`${model.name}: up to date`);
        continue;
    }
    const data = await fetchWithRetry(model.url);
    const actual = sha256(data);
    if (actual !== model.sha256) {
        console.error(`${model.name}: SHA-256 mismatch (expected ${model.sha256}, got ${actual})`);
        process.exit(1);
    }
    await writeFile(`${path}.part`, data);
    await rename(`${path}.part`, path);
    console.log(`${model.name}: downloaded ${(data.length / 1048576).toFixed(1)} MiB`);
}
