import {
    Button,
    Card,
    CardBody,
    CardFooter,
    ButtonGroup,
    Chip,
    Tooltip,
    Spacer,
    Skeleton,
    Dropdown,
    DropdownTrigger,
    DropdownMenu,
    DropdownItem,
} from '@nextui-org/react';
import React, { useEffect, useRef, useState } from 'react';
import { writeText } from '@tauri-apps/api/clipboard';
import { appWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { MdContentCopy } from 'react-icons/md';
import { MdSmartButton } from 'react-icons/md';
import { useTranslation } from 'react-i18next';
import { HiTranslate } from 'react-icons/hi';
import { LuDelete, LuImage } from 'react-icons/lu';
import { GiCycle } from 'react-icons/gi';
import { invoke } from '@tauri-apps/api';
import { atom, useAtom, useSetAtom } from 'jotai';
import { getServiceName } from '../../../../utils/service_instance';
import { useConfig, useServiceInstanceList, useSyncAtom } from '../../../../hooks';
import { dismissWindow, WINDOW_HIDE_EVENT } from '../../../../utils/window';
import * as recognizeServices from '../../../../services/recognize';
import detect from '../../../../utils/lang_detect';
import { joinRecognizedLines } from '../../../../utils/join_lines';
import { TOOLTIP_DELAY } from '../../../../utils/feedback';

export const sourceTextAtom = atom('');
export const detectLanguageAtom = atom('');

export default function SourceArea(props) {
    const { serviceInstanceConfigMap } = props;
    const [sourceText, setSourceText, syncSourceText] = useSyncAtom(sourceTextAtom);
    const setSourceTextAtom = useSetAtom(sourceTextAtom);
    const [detectLanguage, setDetectLanguage] = useAtom(detectLanguageAtom);
    const [incrementalTranslate] = useConfig('incremental_translate', false);
    const [dynamicTranslate] = useConfig('dynamic_translate', false);
    const [deleteNewline] = useConfig('translate_delete_newline', false);
    const [recognizeLanguage, setRecognizeLanguage] = useConfig('recognize_language', 'auto');
    const [recognizeDeleteNewline] = useConfig('recognize_delete_newline', false);
    const [recognizeAutoCopy] = useConfig('recognize_auto_copy', false);
    const [showImage, setShowImage] = useConfig('image_translate_show_image', false);
    const [recognizeServiceList] = useServiceInstanceList('recognize_service_list', ['system']);
    const [hideWindow] = useConfig('translate_hide_window', false);
    const [hideSource] = useConfig('hide_source', false);
    const [windowType, setWindowType] = useState('[SELECTION_TRANSLATE]');
    const [imageBase64, setImageBase64] = useState('');
    const [recognizing, setRecognizing] = useState(false);
    const [recognizeError, setRecognizeError] = useState('');
    const { t } = useTranslation();
    const textAreaRef = useRef();
    const handleNewTextRef = useRef();
    const changeSourceTextRef = useRef();
    const sourceTextChangeTimerRef = useRef(null);
    // only the latest recognition may write its result
    const recognizeIdRef = useRef(0);
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

    const clearImage = () => {
        recognizeIdRef.current++;
        setImageBase64('');
        setRecognizing(false);
        setRecognizeError('');
    };

    const cancelPendingTranslate = () => {
        if (sourceTextChangeTimerRef.current) {
            clearTimeout(sourceTextChangeTimerRef.current);
            sourceTextChangeTimerRef.current = null;
        }
    };

    const translateNow = (text) => {
        cancelPendingTranslate();
        detect_language(text).then(() => {
            syncSourceText();
        });
    };

    // recognize the screenshot and put the text in the source box; `append` follows incremental translate
    const recognizeImage = (base64, language, append = false) => {
        const id = ++recognizeIdRef.current;
        setRecognizeError('');
        const serviceInstanceKey = recognizeServiceList[0];
        const service = recognizeServices[getServiceName(serviceInstanceKey)];
        if (!service || !(language in service.Language)) {
            setRecognizing(false);
            setRecognizeError('Language not supported');
            return;
        }
        setRecognizing(true);
        service
            .recognize(base64, service.Language[language], {
                config: serviceInstanceConfigMap[serviceInstanceKey],
            })
            .then(
                (v) => {
                    if (recognizeIdRef.current !== id) return;
                    let newText = v.trim();
                    if (recognizeDeleteNewline) {
                        newText = joinRecognizedLines(newText);
                    }
                    setRecognizing(false);
                    if (recognizeAutoCopy) {
                        writeText(newText);
                    }
                    if (append) {
                        setSourceText((old) => {
                            return old + ' ' + newText;
                        });
                    } else {
                        setSourceText(newText);
                    }
                    translateNow(newText);
                },
                (e) => {
                    if (recognizeIdRef.current !== id) return;
                    setRecognizing(false);
                    setRecognizeError(e.toString());
                }
            );
    };

    const handleNewText = async (text) => {
        text = text.trim();
        cancelPendingTranslate();
        clearImage();
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
            setRecognizing(true);
            const base64 = await invoke('get_base64');
            setImageBase64(base64);
            recognizeImage(base64, recognizeLanguage, incrementalTranslate);
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
            translateNow(sourceText);
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
        const onHide = () => {
            cancelPendingTranslate();
            clearSourceText();
            clearImage();
        };
        window.addEventListener(WINDOW_HIDE_EVENT, onHide);
        return () => {
            unlisten.then((f) => {
                f();
            });
            window.removeEventListener(WINDOW_HIDE_EVENT, onHide);
        };
    }, []);

    // fetch the text that opened the window once, after the config it depends on has loaded
    useEffect(() => {
        if (
            !initializedRef.current &&
            deleteNewline !== null &&
            incrementalTranslate !== null &&
            recognizeLanguage !== null &&
            recognizeDeleteNewline !== null &&
            recognizeAutoCopy !== null &&
            recognizeServiceList !== null &&
            hideWindow !== null
        ) {
            initializedRef.current = true;
            invoke('get_text').then((v) => {
                handleTextOnce('get_text', v);
            });
        }
    }, [
        deleteNewline,
        incrementalTranslate,
        recognizeLanguage,
        recognizeDeleteNewline,
        recognizeAutoCopy,
        recognizeServiceList,
        hideWindow,
    ]);

    useEffect(() => {
        textAreaRef.current.style.height = '50px';
        textAreaRef.current.style.height = textAreaRef.current.scrollHeight + 'px';
    }, [sourceText]);

    const detect_language = async (text) => {
        setDetectLanguage(await detect(text));
    };

    // only user edits go through here: translate once typing has paused for a second
    const changeSourceText = async (text) => {
        setDetectLanguage('');
        await setSourceText(text);
        cancelPendingTranslate();
        if (dynamicTranslate) {
            sourceTextChangeTimerRef.current = setTimeout(() => {
                sourceTextChangeTimerRef.current = null;
                detect_language(text).then(() => {
                    syncSourceText();
                });
            }, 1000);
        }
    };
    changeSourceTextRef.current = changeSourceText;

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

                await changeSourceTextRef.current(targetText);
                textAreaRef.current.selectionStart = selectionStart;
                textAreaRef.current.selectionEnd = selectionStart + convertedText.length;
            }
        });
    }, [textAreaRef]);


    const isImage = windowType === '[IMAGE_TRANSLATE]';
    const recognizeService =
        recognizeServiceList !== null ? recognizeServices[getServiceName(recognizeServiceList[0])] : undefined;
    const recognizeLanguageList = recognizeService ? Object.keys(recognizeService.Language) : [];

    return (
        <div className={hideSource && windowType !== '[INPUT_TRANSLATE]' ? 'hidden' : ''}>
            <Card
                shadow='none'
                className='bg-content1 rounded-card border-1 border-divider mt-[1px] pb-0'
            >
                {isImage && (
                    <div className='flex justify-between items-center px-[12px] pt-[5px]'>
                        <div className='flex items-center'>
                            {recognizeLanguage !== null && (
                                <Dropdown>
                                    <DropdownTrigger>
                                        <Button
                                            size='sm'
                                            radius='sm'
                                            variant='light'
                                            aria-label={t('translate.recognize_language')}
                                        >
                                            {t(`languages.${recognizeLanguage}`)}
                                        </Button>
                                    </DropdownTrigger>
                                    <DropdownMenu
                                        aria-label={t('translate.recognize_language')}
                                        className='max-h-[40vh] overflow-y-auto'
                                        onAction={(key) => {
                                            setRecognizeLanguage(key);
                                            if (imageBase64 !== '' && !recognizing) {
                                                recognizeImage(imageBase64, key);
                                            }
                                        }}
                                    >
                                        {recognizeLanguageList.map((x) => {
                                            return <DropdownItem key={x}>{t(`languages.${x}`)}</DropdownItem>;
                                        })}
                                    </DropdownMenu>
                                </Dropdown>
                            )}
                            <Tooltip
                                delay={TOOLTIP_DELAY}
                                content={t('translate.recognize')}
                            >
                                <Button
                                    isIconOnly
                                    variant='light'
                                    size='sm'
                                    aria-label={t('translate.recognize')}
                                    isDisabled={imageBase64 === '' || recognizing}
                                    onPress={() => {
                                        recognizeImage(imageBase64, recognizeLanguage);
                                    }}
                                >
                                    <GiCycle className='text-[16px]' />
                                </Button>
                            </Tooltip>
                        </div>
                        <Tooltip
                            delay={TOOLTIP_DELAY}
                            content={t(showImage ? 'translate.hide_image' : 'translate.show_image')}
                        >
                            <Button
                                isIconOnly
                                variant='light'
                                size='sm'
                                aria-label={t(showImage ? 'translate.hide_image' : 'translate.show_image')}
                                color={showImage ? 'primary' : 'default'}
                                isDisabled={imageBase64 === ''}
                                onPress={() => {
                                    setShowImage(!showImage);
                                }}
                            >
                                <LuImage className='text-[16px]' />
                            </Button>
                        </Tooltip>
                    </div>
                )}
                {isImage && showImage && imageBase64 !== '' && (
                    <div className='px-[12px] pt-[5px]'>
                        <img
                            src={`data:image/png;base64,${imageBase64}`}
                            className='w-full max-h-[160px] object-contain rounded-card'
                            draggable={false}
                        />
                    </div>
                )}
                <CardBody className='bg-content1 p-[12px] pb-0 max-h-[40vh] overflow-y-auto'>
                    {isImage && recognizing && (
                        <div className='space-y-3 pb-[12px] logos-fade-in'>
                            <Skeleton className='w-3/5 rounded-lg'>
                                <div className='h-3 w-3/5 rounded-lg bg-default-200'></div>
                            </Skeleton>
                            <Skeleton className='w-4/5 rounded-lg'>
                                <div className='h-3 w-4/5 rounded-lg bg-default-200'></div>
                            </Skeleton>
                            <Skeleton className='w-2/5 rounded-lg'>
                                <div className='h-3 w-2/5 rounded-lg bg-default-300'></div>
                            </Skeleton>
                        </div>
                    )}
                    {isImage && !recognizing && recognizeError !== '' && (
                        <div className='text-[length:var(--app-font-size)] text-danger pb-[12px] select-text whitespace-pre-wrap logos-enter'>
                            {recognizeError}
                        </div>
                    )}
                    {/* logos-enter replays whenever the textarea comes back from display:none (OCR finished) */}
                    <textarea
                        autoFocus
                        ref={textAreaRef}
                        className={`text-[length:var(--app-font-size)] bg-content1 h-full resize-none outline-none logos-enter ${
                            isImage && (recognizing || recognizeError !== '') ? 'hidden' : ''
                        }`}
                        value={sourceText}
                        onKeyDown={keyDown}
                        onChange={(e) => {
                            const v = e.target.value;
                            changeSourceText(v);
                        }}
                    />
                </CardBody>

                <CardFooter className='bg-content1 rounded-none flex justify-between px-[12px] p-[5px]'>
                    <div className='flex justify-start'>
                        <ButtonGroup className='mr-[5px]'>
                            <Tooltip
                                delay={TOOLTIP_DELAY}
                                content={t('translate.copy')}
                            >
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
                            <Tooltip
                                delay={TOOLTIP_DELAY}
                                content={t('translate.delete_newline')}
                            >
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
                            <Tooltip
                                delay={TOOLTIP_DELAY}
                                content={t('common.clear')}
                            >
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
                                variant='dot'
                                className='my-auto'
                            >
                                {t(`languages.${detectLanguage}`)}
                            </Chip>
                        )}
                    </div>
                    <Tooltip
                        delay={TOOLTIP_DELAY}
                        content={t('translate.translate')}
                    >
                        <Button
                            size='sm'
                            variant='light'
                            isIconOnly
                            className='text-[14px] font-semibold'
                            startContent={<HiTranslate className='text-[16px]' />}
                            onPress={() => {
                                translateNow(sourceText);
                            }}
                        />
                    </Tooltip>
                </CardFooter>
            </Card>
            <Spacer y={2} />
        </div>
    );
}
