import { Button, Card, CardBody, CardFooter, ButtonGroup, Chip, Tooltip, Spacer } from '@nextui-org/react';
import React, { useEffect, useRef, useState } from 'react';
import { writeText } from '@tauri-apps/api/clipboard';
import { appWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { MdContentCopy } from 'react-icons/md';
import { MdSmartButton } from 'react-icons/md';
import { useTranslation } from 'react-i18next';
import { HiTranslate } from 'react-icons/hi';
import { LuDelete } from 'react-icons/lu';
import { invoke } from '@tauri-apps/api';
import { atom, useAtom, useSetAtom } from 'jotai';
import { getServiceName } from '../../../../utils/service_instance';
import { useConfig, useServiceInstanceList, useSyncAtom } from '../../../../hooks';
import { dismissWindow, WINDOW_HIDE_EVENT } from '../../../../utils/window';
import * as recognizeServices from '../../../../services/recognize';
import detect from '../../../../utils/lang_detect';

export const sourceTextAtom = atom('');
export const detectLanguageAtom = atom('');

export default function SourceArea(props) {
    const { serviceInstanceConfigMap } = props;
    const [appFontSize] = useConfig('app_font_size', 16);
    const [sourceText, setSourceText, syncSourceText] = useSyncAtom(sourceTextAtom);
    const setSourceTextAtom = useSetAtom(sourceTextAtom);
    const [detectLanguage, setDetectLanguage] = useAtom(detectLanguageAtom);
    const [incrementalTranslate] = useConfig('incremental_translate', false);
    const [dynamicTranslate] = useConfig('dynamic_translate', false);
    const [deleteNewline] = useConfig('translate_delete_newline', false);
    const [recognizeLanguage] = useConfig('recognize_language', 'auto');
    const [recognizeServiceList] = useServiceInstanceList('recognize_service_list', ['system', 'tesseract']);
    const [hideWindow] = useConfig('translate_hide_window', false);
    const [hideSource] = useConfig('hide_source', false);
    const [windowType, setWindowType] = useState('[SELECTION_TRANSLATE]');
    const { t } = useTranslation();
    const textAreaRef = useRef();
    const handleNewTextRef = useRef();
    const initializedRef = useRef(false);
    // On first open both `new_text` and the initial get_text may deliver the same text;
    // remember which source handled what so the duplicate is dropped
    const lastTextRef = useRef({ source: '', text: null, time: 0 });
    const handleTextOnce = (source, text) => {
        const last = lastTextRef.current;
        if (last.source !== source && last.text === text && Date.now() - last.time < 2000) {
            lastTextRef.current = { source: '', text: null, time: 0 };
            return;
        }
        lastTextRef.current = { source, text, time: Date.now() };
        handleNewTextRef.current(text);
    };

    // clear the text and every result, so a previous translation is never shown for new input
    const clearSourceText = () => {
        setSourceText('');
        setSourceTextAtom('');
        setDetectLanguage('');
    };

    const handleNewText = async (text) => {
        text = text.trim();
        if (hideWindow) {
            appWindow.hide();
        } else {
            appWindow.show();
            appWindow.setFocus();
        }
        if (!incrementalTranslate) {
            clearSourceText();
        }
        // 清空检测语言
        setDetectLanguage('');
        if (text === '[INPUT_TRANSLATE]') {
            setWindowType('[INPUT_TRANSLATE]');
            appWindow.show();
            appWindow.setFocus();
            setSourceText('');
        } else if (text === '[IMAGE_TRANSLATE]') {
            setWindowType('[IMAGE_TRANSLATE]');
            const base64 = await invoke('get_base64');
            const serviceInstanceKey = recognizeServiceList[0];
            const service = recognizeServices[getServiceName(serviceInstanceKey)];
            if (service && recognizeLanguage in service.Language) {
                const instanceConfig = serviceInstanceConfigMap[serviceInstanceKey];
                service
                    .recognize(base64, service.Language[recognizeLanguage], {
                        config: instanceConfig,
                    })
                    .then(
                        (v) => {
                            let newText = v.trim();
                            if (deleteNewline) {
                                newText = v.replace(/\-\s+/g, '').replace(/\s+/g, ' ');
                            } else {
                                newText = v.trim();
                            }
                            if (incrementalTranslate) {
                                setSourceText((old) => {
                                    return old + ' ' + newText;
                                });
                            } else {
                                setSourceText(newText);
                            }
                            detect_language(newText).then(() => {
                                syncSourceText();
                            });
                        },
                        (e) => {
                            setSourceText(e.toString());
                        }
                    );
            } else {
                setSourceText('Language not supported');
            }
        } else {
            setWindowType('[SELECTION_TRANSLATE]');
            let newText = text.trim();
            if (deleteNewline) {
                newText = text.replace(/\-\s+/g, '').replace(/\s+/g, ' ');
            } else {
                newText = text.trim();
            }
            if (incrementalTranslate) {
                setSourceText((old) => {
                    return old + ' ' + newText;
                });
            } else {
                setSourceText(newText);
            }
            detect_language(newText).then(() => {
                syncSourceText();
            });
        }
    };
    // the window stays alive between activations, so listeners must always call the latest closure
    handleNewTextRef.current = handleNewText;

    const keyDown = (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            detect_language(sourceText).then(() => {
                syncSourceText();
            });
        }
        if (event.key === 'Escape') {
            dismissWindow();
        }
    };

    useEffect(() => {
        const unlisten = listen('new_text', (event) => {
            appWindow.setFocus();
            handleTextOnce('event', event.payload);
        });
        window.addEventListener(WINDOW_HIDE_EVENT, clearSourceText);
        return () => {
            unlisten.then((f) => {
                f();
            });
            window.removeEventListener(WINDOW_HIDE_EVENT, clearSourceText);
        };
    }, []);

    // fetch the text that opened the window once, after the config it depends on has loaded
    useEffect(() => {
        if (
            !initializedRef.current &&
            deleteNewline !== null &&
            incrementalTranslate !== null &&
            recognizeLanguage !== null &&
            recognizeServiceList !== null &&
            hideWindow !== null
        ) {
            initializedRef.current = true;
            invoke('get_text').then((v) => {
                handleTextOnce('get_text', v);
            });
        }
    }, [deleteNewline, incrementalTranslate, recognizeLanguage, recognizeServiceList, hideWindow]);

    useEffect(() => {
        textAreaRef.current.style.height = '50px';
        textAreaRef.current.style.height = textAreaRef.current.scrollHeight + 'px';
    }, [sourceText]);

    const detect_language = async (text) => {
        setDetectLanguage(await detect(text));
    };

    let sourceTextChangeTimer = null;
    const changeSourceText = async (text) => {
        setDetectLanguage('');
        await setSourceText(text);
        if (dynamicTranslate) {
            if (sourceTextChangeTimer) {
                clearTimeout(sourceTextChangeTimer);
            }
            sourceTextChangeTimer = setTimeout(() => {
                detect_language(text).then(() => {
                    syncSourceText();
                });
            }, 1000);
        }
    }

    const transformVarName = function (str) {
        let str2 = str;

        // snake_case to SNAKE_CASE
        if (/_[a-z]/.test(str2)) {
            str2 = str2.split('_').map(it => it.toLocaleUpperCase()).join('_');
        }
        if (str2 !== str) {
            return str2;
        }

        // SNAKE_CASE to kebab-case
        if (/^[A-Z]+(_[A-Z]+)*$/.test(str2)) {
            str2 = str2.split('_').map(it => it.toLocaleLowerCase()).join('-');
        }
        if (str2 !== str) {
            return str2;
        }

        // kebab-case to dot.notation
        if (/-/.test(str2)) {
            str2 = str2.split('-').map(it => it.toLocaleLowerCase()).join('.');
        }
        if (str2 !== str) {
            return str2;
        }

        // dot.notation to space separated
        if (/\.[a-z]/.test(str2)) {
            str2 = str2.replaceAll(/(\.)([a-z])/g, (_, _2, it) => ' ' + it);
        }
        if (str2 !== str) {
            return str2;
        }

        // space separated to Title Case
        if (/\s[a-z]/.test(str2)) {
            str2 = str2.replaceAll(/\s([a-z])/g, (_, it) => ' ' + it.toLocaleUpperCase());
            str2 = str2.substring(0, 1).toLocaleUpperCase() + str2.substring(1);
        }
        if (str2 !== str) {
            return str2;
        }

        // Title Case to CamelCase
        if (/\s[A-Z]/.test(str2)) {
            str2 = str2.replaceAll(/\s([A-Z])/g, (_, it) => it);
            str2 = str2.substring(0, 1).toLocaleLowerCase() + str2.substring(1);
        }
        if (str2 !== str) {
            return str2;
        }

        // CamelCase to PascalCase
        if (/^[a-z]+[A-Z]+/.test(str2)) {
            str2 = str2.substring(0, 1).toLocaleUpperCase() + str2.substring(1);
        }
        if (str2 !== str) {
            return str2;
        }

        // PascalCase to snake_case
        if (/[^\s][A-Z]/.test(str2)) {
            str2 = str2.replaceAll(/[A-Z]/g, (it, offset) => {
                return (offset == 0 ? '' : '_') + it.toLocaleLowerCase();
            });
        }

        return str2;
    }
    useEffect(() => {
        textAreaRef.current.addEventListener("keydown", async (event) => {
            if (event.altKey && event.shiftKey && event.code === 'KeyU') {
                const originText = textAreaRef.current.value;
                const selectionStart = textAreaRef.current.selectionStart;
                const selectionEnd = textAreaRef.current.selectionEnd;
                const selectionText = originText.substring(selectionStart, selectionEnd);

                const convertedText = transformVarName(selectionText);
                const targetText = originText.substring(0, selectionStart) + convertedText + originText.substring(selectionEnd);

                await changeSourceText(targetText);
                textAreaRef.current.selectionStart = selectionStart;
                textAreaRef.current.selectionEnd = selectionStart + convertedText.length;
            }
        });
    }, [textAreaRef]);


    return (
        <div className={hideSource && windowType !== '[INPUT_TRANSLATE]' && 'hidden'}>
            <Card
                shadow='none'
                className='bg-content1 rounded-[10px] mt-[1px] pb-0'
            >
                <CardBody className='bg-content1 p-[12px] pb-0 max-h-[40vh] overflow-y-auto'>
                    <textarea
                        autoFocus
                        ref={textAreaRef}
                        className={`text-[${appFontSize}px] bg-content1 h-full resize-none outline-none`}
                        value={sourceText}
                        onKeyDown={keyDown}
                        onChange={(e) => {
                            const v = e.target.value;
                            changeSourceText(v);
                        }}
                    />
                </CardBody>

                <CardFooter className='bg-content1 rounded-none rounded-b-[10px] flex justify-between px-[12px] p-[5px]'>
                    <div className='flex justify-start'>
                        <ButtonGroup className='mr-[5px]'>
                            <Tooltip content={t('translate.copy')}>
                                <Button
                                    isIconOnly
                                    variant='light'
                                    size='sm'
                                    onPress={() => {
                                        writeText(sourceText);
                                    }}
                                >
                                    <MdContentCopy className='text-[16px]' />
                                </Button>
                            </Tooltip>
                            <Tooltip content={t('translate.delete_newline')}>
                                <Button
                                    isIconOnly
                                    variant='light'
                                    size='sm'
                                    onPress={() => {
                                        const newText = sourceText.replace(/\-\s+/g, '').replace(/\s+/g, ' ');
                                        setSourceText(newText);
                                        detect_language(newText).then(() => {
                                            syncSourceText();
                                        });
                                    }}
                                >
                                    <MdSmartButton className='text-[16px]' />
                                </Button>
                            </Tooltip>
                            <Tooltip content={t('common.clear')}>
                                <Button
                                    variant='light'
                                    size='sm'
                                    isIconOnly
                                    isDisabled={sourceText === ''}
                                    onPress={() => {
                                        setSourceText('');
                                    }}
                                >
                                    <LuDelete className='text-[16px]' />
                                </Button>
                            </Tooltip>
                        </ButtonGroup>
                        {detectLanguage !== '' && (
                            <Chip
                                size='sm'
                                color='secondary'
                                variant='dot'
                                className='my-auto'
                            >
                                {t(`languages.${detectLanguage}`)}
                            </Chip>
                        )}
                    </div>
                    <Tooltip content={t('translate.translate')}>
                        <Button
                            size='sm'
                            color='primary'
                            variant='light'
                            isIconOnly
                            className='text-[14px] font-bold'
                            startContent={<HiTranslate className='text-[16px]' />}
                            onPress={() => {
                                detect_language(sourceText).then(() => {
                                    syncSourceText();
                                });
                            }}
                        />
                    </Tooltip>
                </CardFooter>
            </Card>
            <Spacer y={2} />
        </div>
    );
}
