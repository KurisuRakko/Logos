import { Card, CardBody, CardFooter, Button, Tooltip } from '@nextui-org/react';
import { appWindow } from '@tauri-apps/api/window';
import React, { useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { MdContentCopy } from 'react-icons/md';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api';
import { atom, useAtom } from 'jotai';

import { useConfig } from '../../../hooks';
import { WINDOW_HIDE_EVENT } from '../../../utils/window';

export const base64Atom = atom('');

export default function ImageArea() {
    const [hideWindow] = useConfig('recognize_hide_window', false);
    const [base64, setBase64] = useAtom(base64Atom);
    const imgRef = useRef();
    const loadImgRef = useRef();
    const initializedRef = useRef(false);
    const { t } = useTranslation();
    const load_img = () => {
        invoke('get_base64').then((v) => {
            setBase64(v);
            if (hideWindow) {
                appWindow.hide();
            } else {
                appWindow.show();
                appWindow.setFocus(true);
            }
        });
    };
    // the window stays alive between activations, so listeners must always call the latest closure
    loadImgRef.current = load_img;

    useEffect(() => {
        // `window_reactivate` is emitted when the backend reuses the hidden window
        const unlistenList = ['new_image', 'window_reactivate'].map((event) =>
            listen(event, () => {
                loadImgRef.current();
            })
        );
        // drop the image (and with it the recognized text) before the window hides
        const reset = () => {
            setBase64('');
        };
        window.addEventListener(WINDOW_HIDE_EVENT, reset);
        return () => {
            unlistenList.forEach((unlisten) => {
                unlisten.then((f) => {
                    f();
                });
            });
            window.removeEventListener(WINDOW_HIDE_EVENT, reset);
        };
    }, []);

    useEffect(() => {
        if (!initializedRef.current && hideWindow !== null) {
            initializedRef.current = true;
            load_img();
        }
    }, [hideWindow]);

    return (
        <Card
            shadow='none'
            className='bg-content1 h-full ml-[12px] mr-[6px]'
            radius='10'
        >
            <CardBody className='bg-content1 h-full p-0'>
                {base64 !== '' && (
                    <img
                        ref={imgRef}
                        draggable={false}
                        className='object-contain h-full w-full'
                        src={'data:image/png;base64,' + base64}
                    />
                )}
            </CardBody>
            <CardFooter className='bg-content1 flex justify-start px-[12px]'>
                <Tooltip content={t('recognize.copy_img')}>
                    <Button
                        isIconOnly
                        size='sm'
                        variant='light'
                        onPress={async () => {
                            await invoke('copy_img', {
                                width: imgRef.current.naturalWidth,
                                height: imgRef.current.naturalHeight,
                            });
                        }}
                    >
                        <MdContentCopy className='text-[16px]' />
                    </Button>
                </Tooltip>
            </CardFooter>
        </Card>
    );
}
