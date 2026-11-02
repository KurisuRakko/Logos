import { appWindow } from '@tauri-apps/api/window';
import { BrowserRouter } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { warn } from 'tauri-plugin-log-api';
import React, { Suspense, lazy, useEffect } from 'react';
import { useTheme } from 'next-themes';

import { dismissWindow } from './utils/window';
import { store } from './utils/store';
import { useConfig } from './hooks';
import './style.css';
import './i18n';

// 每个窗口只加载自己的代码：翻译窗不会打包加载 Config 等页面
const windowMap = {
    translate: lazy(() => import('./window/Translate')),
    screenshot: lazy(() => import('./window/Screenshot')),
    config: lazy(() => import('./window/Config')),
};

export default function App() {
    const [appTheme] = useConfig('app_theme', 'system');
    const [appLanguage] = useConfig('app_language', 'en');
    const [appFont] = useConfig('app_font', 'default');
    const [appFallbackFont] = useConfig('app_fallback_font', 'default');
    const [appFontSize] = useConfig('app_font_size', 16);
    const { setTheme, resolvedTheme } = useTheme();
    const { i18n } = useTranslation();

    useEffect(() => {
        store.load();
    }, []);

    useEffect(() => {
        const onKeyDown = async (e) => {
            let allowKeys = ['c', 'v', 'x', 'a', 'z', 'y'];
            if (e.ctrlKey && !allowKeys.includes(e.key.toLowerCase())) {
                e.preventDefault();
            }
            if (e.key.startsWith('F') && e.key.length > 1) {
                e.preventDefault();
            }
            if (e.key === 'Escape') {
                await dismissWindow();
            }
        };
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('keydown', onKeyDown);
        };
    }, []);

    useEffect(() => {
        if (appTheme !== null) {
            if (appTheme !== 'system') {
                setTheme(appTheme);
            } else {
                try {
                    if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
                        setTheme('dark');
                    } else {
                        setTheme('light');
                    }
                    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
                        if (e.matches) {
                            setTheme('dark');
                        } else {
                            setTheme('light');
                        }
                    });
                } catch {
                    warn("Can't detect system theme.");
                }
            }
        }
    }, [appTheme]);

    // NextUI follows the `dark` class, Rakko Design tokens follow data-theme
    useEffect(() => {
        if (resolvedTheme) {
            document.documentElement.dataset.theme = resolvedTheme;
        }
    }, [resolvedTheme]);

    useEffect(() => {
        if (appLanguage !== null) {
            i18n.changeLanguage(appLanguage);
        }
    }, [appLanguage]);

    useEffect(() => {
        if (appFont !== null && appFallbackFont !== null) {
            // fonts picked in settings go in front of the Rakko Design sans / serif stacks
            const picked = [appFont, appFallbackFont].filter((font) => font !== 'default').map((font) => `"${font}"`);
            const root = document.documentElement.style;
            if (picked.length > 0) {
                root.setProperty('--app-font-sans', `${picked.join(', ')}, var(--font-sans)`);
                root.setProperty('--app-font-serif', `${picked.join(', ')}, var(--font-serif)`);
            } else {
                root.removeProperty('--app-font-sans');
                root.removeProperty('--app-font-serif');
            }
        }
        if (appFontSize !== null) {
            document.documentElement.style.fontSize = `${appFontSize}px`;
            document.documentElement.style.setProperty('--app-font-size', `${appFontSize}px`);
        }
    }, [appFont, appFallbackFont, appFontSize]);

    const WindowComponent = windowMap[appWindow.label];

    return (
        <BrowserRouter>
            <Suspense fallback={null}>{WindowComponent && <WindowComponent />}</Suspense>
        </BrowserRouter>
    );
}
