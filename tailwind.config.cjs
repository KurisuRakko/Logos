// tailwind.config.js
const { nextui } = require('@nextui-org/react');

// NextUI turns theme colors into HSL channels at build time, so it needs literal values instead of var().
// Values are copied from vendor/rakko-design/tokens.generated.css; comments name the source token.
const rakko = {
    light: {
        paper: '#faf9f5', // --color-paper
        n1: '#f9f8f5', // --color-neutral-1
        n2: '#f0efeb', // --color-neutral-2
        n3: '#e3e1db', // --color-neutral-3
        n4: '#d0cec6', // --color-neutral-4
        n5: '#a8a69f', // --color-neutral-5
        n6: '#787670', // --color-neutral-6
        n7: '#5c5a55', // --color-neutral-7
        n8: '#403f3a', // --color-neutral-8
        n9: '#24231f', // --color-neutral-9
        n10: '#141312', // --color-neutral-10
        border: 'rgba(24, 24, 27, 0.1)', // --color-border
    },
    dark: {
        paper: '#1a1814', // [data-theme='dark'] --color-paper
        n1: '#141414', // [data-theme='dark'] --color-neutral-1
        n2: '#242424', // [data-theme='dark'] --color-neutral-2
        n3: '#404040', // [data-theme='dark'] --color-neutral-3
        n4: '#5c5c5c', // [data-theme='dark'] --color-neutral-4
        n5: '#787878', // [data-theme='dark'] --color-neutral-5
        n6: '#a8a8a8', // [data-theme='dark'] --color-neutral-6
        n7: '#d0d0d0', // [data-theme='dark'] --color-neutral-7
        n8: '#e3e3e3', // [data-theme='dark'] --color-neutral-8
        n9: '#f0f0f0', // [data-theme='dark'] --color-neutral-9
        n10: '#f8f8f8', // [data-theme='dark'] --color-neutral-10
        border: 'rgba(255, 255, 255, 0.1)', // [data-theme='dark'] --color-border
    },
    // the accent and semantic colors have no dark override in the tokens
    accent: '#c56473', // --color-accent
    info: '#3d6896', // --color-info
    success: '#5e9f7e', // --color-success
    warning: '#a87a3d', // --color-warning
    error: '#a64953', // --color-error
};

const onColor = rakko.light.n1; // text on accent / semantic fills, both themes

const themeColors = (c, { content, defaultScale }) => ({
    background: c.paper,
    foreground: c.n9,
    divider: c.border,
    focus: rakko.accent,
    content1: { DEFAULT: c[content[0]], foreground: c.n9 },
    content2: { DEFAULT: c[content[1]], foreground: c.n9 },
    content3: { DEFAULT: c[content[2]], foreground: c.n9 },
    content4: { DEFAULT: c[content[3]], foreground: c.n9 },
    // 400 icons, 500 secondary text, 700+ body text
    default: {
        DEFAULT: c.n3,
        foreground: c.n9,
        ...Object.fromEntries(
            [50, 100, 200, 300, 400, 500, 600, 700, 800, 900].map((step, i) => [step, c[defaultScale[i]]])
        ),
    },
    // accent stays under 5% of a surface: focus ring, selected item, switch on
    primary: { DEFAULT: rakko.accent, foreground: onColor },
    secondary: { DEFAULT: rakko.info, foreground: onColor },
    success: { DEFAULT: rakko.success, foreground: onColor },
    warning: { DEFAULT: rakko.warning, foreground: onColor },
    danger: { DEFAULT: rakko.error, foreground: onColor },
});

/** @type {import('tailwindcss').Config} */
module.exports = {
    content: [
        // ...
        './index.html',
        './src/**/*.{js,ts,jsx,tsx}',
        './node_modules/@nextui-org/theme/dist/**/*.{js,ts,jsx,tsx}',
    ],
    theme: {
        extend: {
            borderRadius: {
                card: 'var(--radius-card)',
                control: 'var(--radius-control)',
            },
            fontFamily: {
                // --app-font-* carry the font picked in settings; App.jsx sets them
                sans: ['var(--app-font-sans, var(--font-sans))'],
                serif: ['var(--app-font-serif, var(--font-serif))'],
                mono: ['var(--font-mono)'],
            },
        },
    },
    darkMode: 'class',
    plugins: [
        nextui({
            layout: {
                radius: {
                    small: '4px', // --radius-control
                    medium: '4px', // --radius-control
                    large: '6px', // --radius-card
                },
            },
            themes: {
                light: {
                    colors: themeColors(rakko.light, {
                        content: ['n1', 'n2', 'n3', 'n4'],
                        defaultScale: ['n1', 'n2', 'n3', 'n4', 'n5', 'n7', 'n7', 'n8', 'n9', 'n10'],
                    }),
                },
                dark: {
                    colors: themeColors(rakko.dark, {
                        content: ['n2', 'n3', 'n4', 'n5'],
                        defaultScale: ['n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n7', 'n8', 'n9', 'n10'],
                    }),
                },
            },
        }),
    ],
};
