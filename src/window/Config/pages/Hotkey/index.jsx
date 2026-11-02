import { unregister, isRegistered } from '@tauri-apps/api/globalShortcut';
import toast, { Toaster } from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { CardBody } from '@nextui-org/react';
import { Button } from '@nextui-org/react';
import { Input } from '@nextui-org/react';
import { Card } from '@nextui-org/react';
import React, { useEffect, useState } from 'react';

import { useConfig } from '../../../../hooks/useConfig';
import { useToastStyle } from '../../../../hooks';
import { osType } from '../../../../utils/env';
import { invoke } from '@tauri-apps/api';

const keyMap = {
    Backquote: '`',
    Backslash: '\\',
    BracketLeft: '[',
    BracketRight: ']',
    Comma: ',',
    Equal: '=',
    Minus: '-',
    Plus: 'PLUS',
    Period: '.',
    Quote: "'",
    Semicolon: ';',
    Slash: '/',
    Backspace: 'Backspace',
    CapsLock: 'Capslock',
    ContextMenu: 'Contextmenu',
    Space: 'Space',
    Tab: 'Tab',
    Convert: 'Convert',
    Delete: 'Delete',
    End: 'End',
    Help: 'Help',
    Home: 'Home',
    PageDown: 'Pagedown',
    PageUp: 'Pageup',
    Escape: 'Esc',
    PrintScreen: 'Printscreen',
    ScrollLock: 'Scrolllock',
    Pause: 'Pause',
    Insert: 'Insert',
    Suspend: 'Suspend',
};

const modifierNames = new Set([
    'ctrl',
    'control',
    'shift',
    'alt',
    'option',
    'super',
    'command',
    'cmd',
    'commandorcontrol',
    'cmdorctrl',
    'meta',
]);

const hotkeyItems = [
    { name: 'hotkey_selection_translate', label: 'config.hotkey.selection_translate' },
    { name: 'hotkey_input_translate', label: 'config.hotkey.input_translate' },
    { name: 'hotkey_ocr_recognize', label: 'config.hotkey.ocr_recognize' },
    { name: 'hotkey_ocr_translate', label: 'config.hotkey.ocr_translate' },
];

function containsNonModifierKey(value) {
    return String(value ?? '')
        .split('+')
        .some((part) => {
            const name = part.trim().toLowerCase();
            return name.length > 0 && !modifierNames.has(name);
        });
}

function buildHotkey(e) {
    let newValue = '';
    if (e.ctrlKey) {
        newValue = 'Ctrl';
    }
    if (e.shiftKey) {
        newValue = `${newValue}${newValue.length > 0 ? '+' : ''}Shift`;
    }
    if (e.metaKey) {
        newValue = `${newValue}${newValue.length > 0 ? '+' : ''}${osType === 'Darwin' ? 'Command' : 'Super'}`;
    }
    if (e.altKey) {
        newValue = `${newValue}${newValue.length > 0 ? '+' : ''}Alt`;
    }
    let code = e.code;
    if (code.startsWith('Key')) {
        code = code.substring(3);
    } else if (code.startsWith('Digit')) {
        code = code.substring(5);
    } else if (code.startsWith('Numpad')) {
        code = 'Num' + code.substring(6);
    } else if (code.startsWith('Arrow')) {
        code = code.substring(5);
    } else if (code.startsWith('Intl')) {
        code = code.substring(4);
    } else if (/F\d+/.test(code)) {
    } else if (keyMap[code] !== undefined) {
        code = keyMap[code];
    } else {
        code = '';
    }
    return `${newValue}${newValue.length > 0 && code.length > 0 ? '+' : ''}${code}`;
}

function HotkeyItem({ name, label, registerHandler, t }) {
    const [value, setValue] = useConfig(name, '');
    const [draft, setDraft] = useState('');

    useEffect(() => {
        setDraft(value ?? '');
    }, [value]);

    if (value === null) {
        return null;
    }

    function keyDown(e) {
        e.preventDefault();
        if (e.keyCode === 8) {
            setDraft('');
            setValue('');
            return;
        }
        const nextValue = buildHotkey(e);
        // Modifier-only input is only a hint; it must never be persisted.
        setDraft(nextValue);
        if (containsNonModifierKey(nextValue)) {
            setValue(nextValue);
        }
    }

    return (
        <div className='config-item'>
            <h3 className='my-auto'>{t(label)}</h3>
            <Input
                type='hotkey'
                variant='bordered'
                value={draft}
                label={t('config.hotkey.set_hotkey')}
                className='max-w-[50%]'
                onKeyDown={keyDown}
                onFocus={() => {
                    unregister(value);
                    setValue('');
                    setDraft('');
                }}
                endContent={
                    <Button
                        size='sm'
                        variant='flat'
                        className={containsNonModifierKey(draft) ? '' : 'hidden'}
                        onPress={() => {
                            registerHandler(name, draft);
                        }}
                    >
                        {t('common.ok')}
                    </Button>
                }
            />
        </div>
    );
}

export default function Hotkey() {
    const { t } = useTranslation();
    const toastStyle = useToastStyle();

    function registerHandler(name, key) {
        isRegistered(key).then((res) => {
            if (res) {
                toast.error(t('config.hotkey.is_register'), { style: toastStyle });
            } else {
                invoke('register_shortcut_by_frontend', {
                    name: name,
                    shortcut: key,
                }).then(
                    () => {
                        toast.success(t('config.hotkey.success'), { style: toastStyle });
                    },
                    (e) => {
                        toast.error(e, { style: toastStyle });
                    }
                );
            }
        });
    }

    return (
        <Card>
            <Toaster />
            <CardBody>
                {hotkeyItems.map((item) => (
                    <HotkeyItem
                        key={item.name}
                        name={item.name}
                        label={item.label}
                        registerHandler={registerHandler}
                        t={t}
                    />
                ))}
            </CardBody>
        </Card>
    );
}
