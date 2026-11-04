import { invoke } from '@tauri-apps/api';

// Runs in-process in the backend (logos-ocr); the image is the current screenshot cut, as with system OCR
export async function recognize(_, lang) {
    const result = await invoke('paddle_ocr', { lang });
    return result.trim();
}

export * from './info';
