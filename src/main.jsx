import { ThemeProvider as NextThemesProvider } from 'next-themes';
import { appWindow } from '@tauri-apps/api/window';
import { NextUIProvider } from '@nextui-org/react';
import { MotionGlobalConfig } from 'framer-motion';
import ReactDOM from 'react-dom/client';
import React from 'react';

import { installFeedback } from './utils/feedback';
import { initStore } from './utils/store';
import { initEnv } from './utils/env';
import App from './App';

// NextUI's own disableAnimation also strips its CSS state transitions (switch thumb, hover),
// so only the framer-motion overlay animations are skipped; style.css gives them a CSS entrance
MotionGlobalConfig.skipAnimations = true;

// NextUI's framer ripple stays off (disableRipple below); Rakko Design's ripple and press run instead
installFeedback();

if (import.meta.env.PROD) {
    document.addEventListener('contextmenu', (e) => {
        e.preventDefault();
    });
}

initStore().then(async () => {
    await initEnv();
    const rootElement = document.getElementById('root');
    const root = ReactDOM.createRoot(rootElement);
    root.render(
        <NextUIProvider disableRipple>
            <NextThemesProvider attribute='class'>
                <App />
            </NextThemesProvider>
        </NextUIProvider>
    );
});
