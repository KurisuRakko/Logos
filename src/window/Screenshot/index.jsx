import React, { useEffect, useState, useRef } from 'react';
import { appCacheDir, join } from '@tauri-apps/api/path';
import { currentMonitor } from '@tauri-apps/api/window';
import { convertFileSrc } from '@tauri-apps/api/tauri';
import { appWindow } from '@tauri-apps/api/window';
import { emit, listen } from '@tauri-apps/api/event';
import { warn } from 'tauri-plugin-log-api';
import { invoke } from '@tauri-apps/api';

import { dismissWindow, WINDOW_HIDE_EVENT } from '../../utils/window';

export default function Screenshot() {
    const [imgurl, setImgurl] = useState('');
    const [isMoved, setIsMoved] = useState(false);
    const [isDown, setIsDown] = useState(false);
    const [mouseDownX, setMouseDownX] = useState(0);
    const [mouseDownY, setMouseDownY] = useState(0);
    const [mouseMoveX, setMouseMoveX] = useState(0);
    const [mouseMoveY, setMouseMoveY] = useState(0);

    const imgRef = useRef();

    // 截屏并加载图片，图片加载完成后由 onLoad 显示窗口
    // target 是后端给出的目标显示器物理坐标；没有时才回退 currentMonitor()
    const capture = async (target) => {
        try {
            if (!target) {
                target = await invoke('get_screenshot_target');
                target = target ? { x: target[0], y: target[1] } : null;
            }
            if (!target) {
                const monitor = await currentMonitor();
                target = { x: monitor.position.x, y: monitor.position.y };
            }
            await invoke('screenshot', { x: target.x, y: target.y });
        } catch (e) {
            // 截屏失败时不能显示上一张图
            warn(`Screenshot failed: ${e}`);
            setImgurl('');
            void appWindow.hide();
            return;
        }
        const filePath = await join(await appCacheDir(), 'pot_screenshot.png');
        // the file path never changes, so bust the webview image cache on every capture
        setImgurl(`${convertFileSrc(filePath)}?t=${Date.now()}`);
    };

    useEffect(() => {
        capture();
        // the window is kept alive: the backend repositions it (without showing) and emits this event
        const unlisten = listen('window_reactivate', (event) => {
            capture(event.payload);
        });
        // drop the full-screen image before hiding to release its memory
        const reset = () => {
            setIsDown(false);
            setIsMoved(false);
            setImgurl('');
        };
        window.addEventListener(WINDOW_HIDE_EVENT, reset);
        return () => {
            unlisten.then((f) => {
                f();
            });
            window.removeEventListener(WINDOW_HIDE_EVENT, reset);
        };
    }, []);

    return (
        <>
            <img
                ref={imgRef}
                className='fixed top-0 left-0 w-full select-none'
                src={imgurl || undefined}
                draggable={false}
                onLoad={() => {
                    if (imgurl !== '' && imgRef.current.complete) {
                        void appWindow.show();
                        void appWindow.setFocus();
                        void appWindow.setResizable(false);
                    }
                }}
            />
            <div
                className={`fixed bg-primary/10 border border-solid border-primary ${!isMoved && 'hidden'}`}
                style={{
                    top: Math.min(mouseDownY, mouseMoveY),
                    left: Math.min(mouseDownX, mouseMoveX),
                    bottom: screen.height - Math.max(mouseDownY, mouseMoveY),
                    right: screen.width - Math.max(mouseDownX, mouseMoveX),
                }}
            />
            <div
                className='fixed top-0 left-0 bottom-0 right-0 cursor-crosshair select-none'
                onMouseDown={(e) => {
                    if (e.buttons === 1) {
                        setIsDown(true);
                        setMouseDownX(e.clientX);
                        setMouseDownY(e.clientY);
                    } else {
                        void dismissWindow();
                    }
                }}
                onMouseMove={(e) => {
                    if (isDown) {
                        setIsMoved(true);
                        setMouseMoveX(e.clientX);
                        setMouseMoveY(e.clientY);
                    }
                }}
                onMouseUp={async (e) => {
                    // hide first and wait for it, so the translate window shown on success gets the focus
                    await appWindow.hide();
                    setIsDown(false);
                    setIsMoved(false);
                    const imgWidth = imgRef.current.naturalWidth;
                    const dpi = imgWidth / screen.width;
                    const left = Math.floor(Math.min(mouseDownX, e.clientX) * dpi);
                    const top = Math.floor(Math.min(mouseDownY, e.clientY) * dpi);
                    const right = Math.floor(Math.max(mouseDownX, e.clientX) * dpi);
                    const bottom = Math.floor(Math.max(mouseDownY, e.clientY) * dpi);
                    const width = right - left;
                    const height = bottom - top;
                    if (width <= 0 || height <= 0) {
                        warn('Screenshot area is too small');
                        await dismissWindow();
                    } else {
                        await invoke('cut_image', { left, top, width, height });
                        // already hidden: only drop the image, a second hide would move the focus again
                        setImgurl('');
                        await emit('success');
                    }
                }}
            />
        </>
    );
}
