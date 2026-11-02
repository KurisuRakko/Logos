import { DragDropContext, Draggable, Droppable } from 'react-beautiful-dnd';
import { appWindow, currentMonitor } from '@tauri-apps/api/window';
import { Spacer, Button } from '@nextui-org/react';
import { AiFillCloseCircle } from 'react-icons/ai';
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { BsPinFill } from 'react-icons/bs';

import LanguageArea from './components/LanguageArea';
import SourceArea from './components/SourceArea';
import TargetArea from './components/TargetArea';
import { osType } from '../../utils/env';
import { useConfig, useServiceInstanceList } from '../../hooks';
import { store, getSnapshot } from '../../utils/store';
import { dismissWindow, WINDOW_HIDE_EVENT } from '../../utils/window';
import { info } from 'tauri-plugin-log-api';

let blurTimeout = null;
let resizeTimeout = null;
let moveTimeout = null;
let unlistenBlurPromise = null;

const listenBlur = () => {
    if (unlistenBlurPromise) {
        return;
    }
    unlistenBlurPromise = listen('tauri://blur', () => {
        if (appWindow.label === 'translate') {
            if (blurTimeout) {
                clearTimeout(blurTimeout);
            }
            info('Blur');
            // 100ms后隐藏窗口，因为在 windows 下拖动窗口时会先切换成 blur 再立即切换成 focus
            // 如果直接隐藏将导致窗口无法拖动
            blurTimeout = setTimeout(async () => {
                info('Confirm Blur');
                await dismissWindow();
            }, 100);
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
    info('Focus');
    if (blurTimeout) {
        info('Cancel Close');
        clearTimeout(blurTimeout);
    }
});
// 监听 move 事件取消 blurTimeout 时间之内的隐藏窗口
void listen('tauri://move', () => {
    info('Move');
    if (blurTimeout) {
        info('Cancel Close');
        clearTimeout(blurTimeout);
    }
});

const eventKeyOf = (key) => key.replaceAll('.', '_').replaceAll('@', ':');

const loadServiceInstanceConfigMap = (serviceInstanceKeyList) => {
    const config = {};
    for (const serviceInstanceKey of serviceInstanceKeyList) {
        config[serviceInstanceKey] = getSnapshot(serviceInstanceKey) ?? {};
    }
    return config;
};

const isSameConfigMap = (a, b) => {
    const keys = Object.keys(b);
    return keys.length === Object.keys(a).length && keys.every((key) => a[key] === b[key]);
};

export default function Translate() {
    const [closeOnBlur] = useConfig('translate_close_on_blur', true);
    const [alwaysOnTop] = useConfig('translate_always_on_top', false);
    const [windowPosition] = useConfig('translate_window_position', 'mouse');
    const [rememberWindowSize] = useConfig('translate_remember_window_size', false);
    const [translateServiceInstanceList, setTranslateServiceInstanceList] = useServiceInstanceList(
        'translate_service_list',
        ['deepl', 'bing', 'lingva', 'yandex', 'google', 'ecdict']
    );
    const [recognizeServiceInstanceList] = useServiceInstanceList('recognize_service_list', ['system']);
    const [hideLanguage] = useConfig('hide_language', false);
    const [pined, setPined] = useState(false);
    const rootRef = useRef(null);
    const [serviceInstanceConfigMap, setServiceInstanceConfigMap] = useState(() =>
        loadServiceInstanceConfigMap([...translateServiceInstanceList, ...recognizeServiceInstanceList])
    );
    const reorder = (list, startIndex, endIndex) => {
        const result = Array.from(list);
        const [removed] = result.splice(startIndex, 1);
        result.splice(endIndex, 0, removed);
        return result;
    };

    const onDragEnd = useCallback(
        (result) => {
            if (!result.destination) return;
            const items = reorder(translateServiceInstanceList, result.source.index, result.destination.index);
            setTranslateServiceInstanceList(items);
        },
        [translateServiceInstanceList]
    );
    // 失焦是否自动隐藏窗口（置顶时不隐藏）
    useEffect(() => {
        if (closeOnBlur === null) return;
        if (closeOnBlur && !pined) {
            listenBlur();
        } else {
            unlistenBlur();
        }
    }, [closeOnBlur, pined]);
    // 是否默认置顶
    useEffect(() => {
        if (alwaysOnTop !== null && alwaysOnTop) {
            appWindow.setAlwaysOnTop(true);
            setPined(true);
        }
    }, [alwaysOnTop]);
    // 窗口常驻：隐藏后恢复为新开窗口时的置顶状态
    useEffect(() => {
        if (alwaysOnTop === null) return;
        const reset = () => {
            if (!alwaysOnTop) {
                appWindow.setAlwaysOnTop(false);
                setPined(false);
            }
        };
        window.addEventListener(WINDOW_HIDE_EVENT, reset);
        return () => {
            window.removeEventListener(WINDOW_HIDE_EVENT, reset);
        };
    }, [alwaysOnTop]);
    // 窗口出现动画：每次从隐藏状态被唤起时重播，隐藏时复位
    useEffect(() => {
        const root = rootRef.current;
        let hidden = false;
        const play = () => {
            root.classList.remove('logos-window-enter');
            void root.offsetWidth;
            root.classList.add('logos-window-enter');
        };
        const onHide = () => {
            hidden = true;
            root.classList.remove('logos-window-enter');
        };
        const onShow = () => {
            if (hidden) {
                hidden = false;
                play();
            }
        };
        play();
        window.addEventListener(WINDOW_HIDE_EVENT, onHide);
        const unlistenList = [listen('window_reactivate', onShow), listen('new_text', onShow)];
        return () => {
            window.removeEventListener(WINDOW_HIDE_EVENT, onHide);
            unlistenList.forEach((unlisten) => {
                unlisten.then((f) => {
                    f();
                });
            });
        };
    }, []);
    // 保存窗口位置
    useEffect(() => {
        if (windowPosition !== null && windowPosition === 'pre_state') {
            const unlistenMove = listen('tauri://move', async () => {
                if (moveTimeout) {
                    clearTimeout(moveTimeout);
                }
                moveTimeout = setTimeout(async () => {
                    if (appWindow.label === 'translate') {
                        let position = await appWindow.outerPosition();
                        const monitor = await currentMonitor();
                        const factor = monitor.scaleFactor;
                        position = position.toLogical(factor);
                        await store.set('translate_window_position_x', parseInt(position.x));
                        await store.set('translate_window_position_y', parseInt(position.y));
                        await store.save();
                    }
                }, 100);
            });
            return () => {
                unlistenMove.then((f) => {
                    f();
                });
            };
        }
    }, [windowPosition]);
    // 保存窗口大小
    useEffect(() => {
        if (rememberWindowSize !== null && rememberWindowSize) {
            const unlistenResize = listen('tauri://resize', async () => {
                if (resizeTimeout) {
                    clearTimeout(resizeTimeout);
                }
                resizeTimeout = setTimeout(async () => {
                    if (appWindow.label === 'translate') {
                        let size = await appWindow.outerSize();
                        const monitor = await currentMonitor();
                        const factor = monitor.scaleFactor;
                        size = size.toLogical(factor);
                        await store.set('translate_window_height', parseInt(size.height));
                        await store.set('translate_window_width', parseInt(size.width));
                        await store.save();
                    }
                }, 100);
            });
            return () => {
                unlistenResize.then((f) => {
                    f();
                });
            };
        }
    }, [rememberWindowSize]);

    useEffect(() => {
        if (translateServiceInstanceList !== null && recognizeServiceInstanceList !== null) {
            const config = loadServiceInstanceConfigMap([
                ...translateServiceInstanceList,
                ...recognizeServiceInstanceList,
            ]);
            // keep the same object when nothing changed, so the result cards are not re-rendered on mount
            setServiceInstanceConfigMap((old) => (isSameConfigMap(old, config) ? old : config));
            // the window is kept alive, so pick up service config edits made in the config window
            const unlistenList = [...translateServiceInstanceList, ...recognizeServiceInstanceList].map((key) =>
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
    }, [translateServiceInstanceList, recognizeServiceInstanceList]);

    return (
        <div
            ref={rootRef}
            className={`bg-background h-screen w-screen ${osType === 'Linux' && 'rounded-lg border-1 border-divider'}`}
        >
            <div
                className='fixed top-[5px] left-[5px] right-[5px] h-[30px]'
                data-tauri-drag-region='true'
            />
            <div className={`h-[35px] w-full flex ${osType === 'Darwin' ? 'justify-end' : 'justify-between'}`}>
                <Button
                    isIconOnly
                    size='sm'
                    variant='flat'
                    disableAnimation
                    className='my-auto bg-transparent'
                    onPress={() => {
                        // blur listening follows `pined` in the effect above
                        appWindow.setAlwaysOnTop(!pined);
                        setPined(!pined);
                    }}
                >
                    <BsPinFill className={`text-[20px] ${pined ? 'text-primary' : 'text-default-400'}`} />
                </Button>
                <Button
                    isIconOnly
                    size='sm'
                    variant='flat'
                    disableAnimation
                    className={`my-auto ${osType === 'Darwin' && 'hidden'} bg-transparent`}
                    onPress={() => {
                        void dismissWindow();
                    }}
                >
                    <AiFillCloseCircle className='text-[20px] text-default-400' />
                </Button>
            </div>
            <div className={`${osType === 'Linux' ? 'h-[calc(100vh-37px)]' : 'h-[calc(100vh-35px)]'} px-[8px]`}>
                <div className='h-full overflow-y-auto'>
                    <div>
                        <SourceArea serviceInstanceConfigMap={serviceInstanceConfigMap} />
                    </div>
                    <div className={`${hideLanguage && 'hidden'}`}>
                        <LanguageArea />
                        <Spacer y={2} />
                    </div>
                    <DragDropContext onDragEnd={onDragEnd}>
                        <Droppable
                            droppableId='droppable'
                            direction='vertical'
                        >
                            {(provided) => (
                                <div
                                    ref={provided.innerRef}
                                    {...provided.droppableProps}
                                >
                                    {translateServiceInstanceList !== null &&
                                        translateServiceInstanceList.map((serviceInstanceKey, index) => {
                                            const config = serviceInstanceConfigMap[serviceInstanceKey] ?? {};
                                            const enable = config['enable'] ?? true;

                                            return enable ? (
                                                <Draggable
                                                    key={serviceInstanceKey}
                                                    draggableId={serviceInstanceKey}
                                                    index={index}
                                                >
                                                    {(provided) => (
                                                        <div
                                                            ref={provided.innerRef}
                                                            {...provided.draggableProps}
                                                        >
                                                            <TargetArea
                                                                {...provided.dragHandleProps}
                                                                index={index}
                                                                name={serviceInstanceKey}
                                                                translateServiceInstanceList={
                                                                    translateServiceInstanceList
                                                                }
                                                                serviceInstanceConfigMap={serviceInstanceConfigMap}
                                                            />
                                                            <Spacer y={2} />
                                                        </div>
                                                    )}
                                                </Draggable>
                                            ) : (
                                                <></>
                                            );
                                        })}
                                </div>
                            )}
                        </Droppable>
                    </DragDropContext>
                </div>
            </div>
        </div>
    );
}
