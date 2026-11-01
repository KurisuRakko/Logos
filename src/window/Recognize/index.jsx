import { appWindow } from '@tauri-apps/api/window';
import React, { useState, useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Button } from '@nextui-org/react';
import { BsPinFill } from 'react-icons/bs';

import WindowControl from '../../components/WindowControl';
import { store } from '../../utils/store';
import { osType } from '../../utils/env';
import { useConfig, useServiceInstanceList } from '../../hooks';
import { dismissWindow, WINDOW_HIDE_EVENT } from '../../utils/window';
import ControlArea from './ControlArea';
import ImageArea from './ImageArea';
import TextArea from './TextArea';

let blurTimeout = null;
let unlistenBlurPromise = null;

const listenBlur = () => {
    if (unlistenBlurPromise) {
        return;
    }
    unlistenBlurPromise = listen('tauri://blur', () => {
        if (appWindow.label === 'recognize') {
            if (blurTimeout) {
                clearTimeout(blurTimeout);
            }
            // 50ms后隐藏窗口，因为在 windows 下拖动窗口时会先切换成 blur 再立即切换成 focus
            // 如果直接隐藏将导致窗口无法拖动
            blurTimeout = setTimeout(async () => {
                await dismissWindow();
            }, 50);
        }
    });
};

// 取消 blur 监听
const unlistenBlur = () => {
    if (blurTimeout) {
        clearTimeout(blurTimeout);
    }
    if (unlistenBlurPromise) {
        unlistenBlurPromise.then((f) => {
            f();
        });
        unlistenBlurPromise = null;
    }
};

listenBlur();

// 监听 focus 事件取消 blurTimeout 时间之内的隐藏窗口
void listen('tauri://focus', () => {
    if (blurTimeout) {
        clearTimeout(blurTimeout);
    }
});

const eventKeyOf = (key) => key.replaceAll('.', '_').replaceAll('@', ':');

export default function Recognize() {
    const [closeOnBlur] = useConfig('recognize_close_on_blur', false);
    const [pined, setPined] = useState(false);
    const [serviceInstanceList] = useServiceInstanceList('recognize_service_list', ['system', 'tesseract']);
    const [serviceInstanceConfigMap, setServiceInstanceConfigMap] = useState(null);

    const loadServiceInstanceConfigMap = async () => {
        const config = {};
        for (const serviceInstanceKey of serviceInstanceList) {
            config[serviceInstanceKey] = (await store.get(serviceInstanceKey)) ?? {};
        }
        setServiceInstanceConfigMap({ ...config });
    };
    useEffect(() => {
        if (serviceInstanceList !== null) {
            loadServiceInstanceConfigMap();
            // the window is kept alive, so pick up service config edits made in the config window
            const unlistenList = serviceInstanceList.map((key) =>
                listen(`${eventKeyOf(key)}_changed`, (e) => {
                    setServiceInstanceConfigMap((old) => ({ ...old, [key]: e.payload ?? {} }));
                })
            );
            return () => {
                unlistenList.forEach((unlisten) => {
                    unlisten.then((f) => {
                        f();
                    });
                });
            };
        }
    }, [serviceInstanceList]);

    // 失焦是否自动隐藏窗口（置顶时不隐藏）
    useEffect(() => {
        if (closeOnBlur === null) return;
        if (closeOnBlur && !pined) {
            listenBlur();
        } else {
            unlistenBlur();
        }
    }, [closeOnBlur, pined]);
    // 窗口常驻：隐藏后取消置顶，与新开窗口一致
    useEffect(() => {
        const reset = () => {
            appWindow.setAlwaysOnTop(false);
            setPined(false);
        };
        window.addEventListener(WINDOW_HIDE_EVENT, reset);
        return () => {
            window.removeEventListener(WINDOW_HIDE_EVENT, reset);
        };
    }, []);

    return (
        serviceInstanceConfigMap !== null && (
            <div
                className={`bg-background h-screen ${
                    osType === 'Linux' && 'rounded-[10px] border-1 border-default-100'
                }`}
            >
                <div
                    data-tauri-drag-region='true'
                    className='fixed top-[5px] left-[5px] right-[5px] h-[30px]'
                />
                <div className={`h-[35px] flex ${osType === 'Darwin' ? 'justify-end' : 'justify-between'}`}>
                    <Button
                        isIconOnly
                        size='sm'
                        variant='flat'
                        disableAnimation
                        className='my-auto mx-[5px] bg-transparent'
                        onPress={() => {
                            // blur listening follows `pined` in the effect above
                            appWindow.setAlwaysOnTop(!pined);
                            setPined(!pined);
                        }}
                    >
                        <BsPinFill className={`text-[20px] ${pined ? 'text-primary' : 'text-default-400'}`} />
                    </Button>
                    {osType !== 'Darwin' && <WindowControl />}
                </div>
                <div
                    className={`${
                        osType === 'Linux' ? 'h-[calc(100vh-87px)]' : 'h-[calc(100vh-85px)]'
                    } grid grid-cols-2`}
                >
                    <ImageArea />
                    <TextArea serviceInstanceConfigMap={serviceInstanceConfigMap} />
                </div>
                <div className='h-[50px]'>
                    <ControlArea
                        serviceInstanceList={serviceInstanceList}
                        serviceInstanceConfigMap={serviceInstanceConfigMap}
                    />
                </div>
            </div>
        )
    );
}
