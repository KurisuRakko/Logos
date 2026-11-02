import {
    Card,
    CardBody,
    CardHeader,
    CardFooter,
    Button,
    ButtonGroup,
    Dropdown,
    DropdownItem,
    DropdownMenu,
    DropdownTrigger,
    Tooltip,
} from '@nextui-org/react';
import { BiCollapseVertical, BiExpandVertical } from 'react-icons/bi';
import { sendNotification } from '@tauri-apps/api/notification';
import React, { useEffect, useState, useRef } from 'react';
import { writeText } from '@tauri-apps/api/clipboard';
import PulseLoader from 'react-spinners/PulseLoader';
import { TbTransformFilled } from 'react-icons/tb';
import { HiOutlineVolumeUp } from 'react-icons/hi';
import { MdContentCopy } from 'react-icons/md';
import { useTranslation } from 'react-i18next';
import { GiCycle } from 'react-icons/gi';
import { useAtomValue } from 'jotai';
import { nanoid } from 'nanoid';

import { sourceLanguageAtom, targetLanguageAtom } from '../LanguageArea';
import { useConfig, useVoice } from '../../../../hooks';
import { sourceTextAtom, detectLanguageAtom } from '../SourceArea';
import * as builtinServices from '../../../../services/translate';

import { info, error as logError } from 'tauri-plugin-log-api';
import { INSTANCE_NAME_CONFIG_KEY, getDisplayInstanceName, getServiceName } from '../../../../utils/service_instance';
import { WINDOW_HIDE_EVENT } from '../../../../utils/window';
import { TOOLTIP_DELAY } from '../../../../utils/feedback';

let translateID = [];

function TargetArea(props) {
    const { index, name, translateServiceInstanceList, serviceInstanceConfigMap, ...drag } = props;

    const [currentTranslateServiceInstanceKey, setCurrentTranslateServiceInstanceKey] = useState(name);
    function getInstanceName(instanceKey, serviceNameSupplier) {
        const instanceConfig = serviceInstanceConfigMap[instanceKey] ?? {};
        return getDisplayInstanceName(instanceConfig[INSTANCE_NAME_CONFIG_KEY], serviceNameSupplier);
    }

    const [translateSecondLanguage] = useConfig('translate_second_language', 'en');
    const [isLoading, setIsLoading] = useState(false);
    const [hide, setHide] = useState(true);

    const [result, setResult] = useState('');
    const [error, setError] = useState('');

    const sourceText = useAtomValue(sourceTextAtom);
    const sourceLanguage = useAtomValue(sourceLanguageAtom);
    const targetLanguage = useAtomValue(targetLanguageAtom);
    const [autoCopy] = useConfig('translate_auto_copy', 'disable');
    const [hideWindow] = useConfig('translate_hide_window', false);

    const detectLanguage = useAtomValue(detectLanguageAtom);
    const { t } = useTranslation();
    const textAreaRef = useRef();
    const speak = useVoice();

    useEffect(() => {
        if (error) {
            logError(`[${currentTranslateServiceInstanceKey}]happened error: ` + error);
        }
    }, [error]);

    // listen to translation
    useEffect(() => {
        setResult('');
        setError('');
        // drop late results of any request started for the previous text
        translateID[index] = null;
        if (sourceText.trim() !== '' && sourceLanguage && targetLanguage && autoCopy !== null && hideWindow !== null) {
            if (autoCopy === 'source') {
                writeText(sourceText).then(() => {
                    if (hideWindow) {
                        sendNotification({ title: t('common.write_clipboard'), body: sourceText });
                    }
                });
            }
            translate();
        } else {
            setIsLoading(false);
            setHide(true);
        }
    }, [sourceText, sourceLanguage, targetLanguage, autoCopy, hideWindow, currentTranslateServiceInstanceKey]);

    // the window is kept alive after being dismissed: start the next activation from the configured service
    useEffect(() => {
        const reset = () => {
            setCurrentTranslateServiceInstanceKey(name);
        };
        window.addEventListener(WINDOW_HIDE_EVENT, reset);
        return () => {
            window.removeEventListener(WINDOW_HIDE_EVENT, reset);
        };
    }, [name]);

    function invokeOnce(fn) {
        let isInvoke = false;

        return (...args) => {
            if (isInvoke) {
                return;
            } else {
                fn(...args);
                isInvoke = true;
            }
        };
    }

    const translate = async () => {
        let id = nanoid();
        translateID[index] = id;

        const translateServiceName = getServiceName(currentTranslateServiceInstanceKey);
        const LanguageEnum = builtinServices[translateServiceName].Language;
        if (sourceLanguage in LanguageEnum && targetLanguage in LanguageEnum) {
            let newTargetLanguage = targetLanguage;
            if (sourceLanguage === 'auto' && targetLanguage === detectLanguage) {
                newTargetLanguage = translateSecondLanguage;
            }
            setIsLoading(true);
            setHide(true);
            const instanceConfig = serviceInstanceConfigMap[currentTranslateServiceInstanceKey];
            const setHideOnce = invokeOnce(setHide);
            builtinServices[translateServiceName]
                .translate(sourceText.trim(), LanguageEnum[sourceLanguage], LanguageEnum[newTargetLanguage], {
                    config: instanceConfig,
                    detect: detectLanguage,
                    setResult: (v) => {
                        if (translateID[index] !== id) return;
                        setResult(v);
                        setHideOnce(false);
                    },
                })
                .then(
                    (v) => {
                        info(`[${currentTranslateServiceInstanceKey}]resolve:` + v);
                        if (translateID[index] !== id) return;
                        setResult(typeof v === 'string' ? v.trim() : v);
                        setIsLoading(false);
                        if (v !== '') {
                            setHideOnce(false);
                        }
                        if (index === 0) {
                            switch (autoCopy) {
                                case 'target':
                                    writeText(v).then(() => {
                                        if (hideWindow) {
                                            sendNotification({ title: t('common.write_clipboard'), body: v });
                                        }
                                    });
                                    break;
                                case 'source_target':
                                    writeText(sourceText.trim() + '\n\n' + v).then(() => {
                                        if (hideWindow) {
                                            sendNotification({
                                                title: t('common.write_clipboard'),
                                                body: sourceText.trim() + '\n\n' + v,
                                            });
                                        }
                                    });
                                    break;
                                default:
                                    break;
                            }
                        }
                    },
                    (e) => {
                        info(`[${currentTranslateServiceInstanceKey}]reject:` + e);
                        if (translateID[index] !== id) return;
                        setError(e.toString());
                        setIsLoading(false);
                    }
                );
        } else {
            setError('Language not supported');
        }
    };

    // hide empty textarea
    useEffect(() => {
        if (textAreaRef.current !== null) {
            textAreaRef.current.style.height = '0px';
            if (result !== '') {
                textAreaRef.current.style.height = textAreaRef.current.scrollHeight + 'px';
            }
        }
    }, [result]);

    return (
        <Card
            shadow='none'
            className='rounded-card border-1 border-divider'
        >
            <CardHeader
                className={`flex justify-between py-1 px-0 bg-content1 h-[30px] rounded-none ${hide ? '' : 'border-b-1 border-divider'}`}
                {...drag}
            >
                {/* current service instance and available service instance to change */}
                <div className='flex'>
                    <Dropdown>
                        <DropdownTrigger>
                            <Button
                                size='sm'
                                variant='solid'
                                className='bg-transparent'
                                startContent={
                                    <img
                                        src={
                                            builtinServices[getServiceName(currentTranslateServiceInstanceKey)].info
                                                .icon
                                        }
                                        className='h-[20px] my-auto'
                                    />
                                }
                            >
                                <div className='my-auto'>
                                    {getInstanceName(currentTranslateServiceInstanceKey, () =>
                                        t(
                                            `services.translate.${getServiceName(currentTranslateServiceInstanceKey)}.title`
                                        )
                                    )}
                                </div>
                            </Button>
                        </DropdownTrigger>
                        <DropdownMenu
                            aria-label='app language'
                            className='max-h-[40vh] overflow-y-auto'
                            onAction={(key) => {
                                setCurrentTranslateServiceInstanceKey(key);
                            }}
                        >
                            {translateServiceInstanceList.map((instanceKey) => {
                                return (
                                    <DropdownItem
                                        key={instanceKey}
                                        startContent={
                                            <img
                                                src={builtinServices[getServiceName(instanceKey)].info.icon}
                                                className='h-[20px] my-auto'
                                            />
                                        }
                                    >
                                        <div className='my-auto'>
                                            {getInstanceName(instanceKey, () =>
                                                t(`services.translate.${getServiceName(instanceKey)}.title`)
                                            )}
                                        </div>
                                    </DropdownItem>
                                );
                            })}
                        </DropdownMenu>
                    </Dropdown>
                    <PulseLoader
                        loading={isLoading}
                        color='var(--color-neutral-5)'
                        size={8}
                        cssOverride={{
                            display: 'inline-block',
                            margin: 'auto',
                            marginLeft: '20px',
                        }}
                    />
                </div>
                {/* content collapse */}
                <div className='flex'>
                    <Button
                        size='sm'
                        isIconOnly
                        variant='light'
                        className='h-[20px] w-[20px]'
                        onPress={() => setHide(!hide)}
                    >
                        {hide ? (
                            <BiExpandVertical className='text-[16px]' />
                        ) : (
                            <BiCollapseVertical className='text-[16px]' />
                        )}
                    </Button>
                </div>
            </CardHeader>
            <div
                className='logos-collapse'
                data-open={!hide}
            >
                <div>
                    {/* result content rises in when it first arrives (streamed chunks keep the class, so they do
                        not replay it); cards arriving together are staggered by their index */}
                    <CardBody
                        className={`p-[12px] pb-0 font-serif ${result !== '' && 'logos-enter'}`}
                        style={{ '--logos-enter-index': index }}
                    >
                        {typeof result === 'string' ? (
                            <textarea
                                ref={textAreaRef}
                                className='text-[length:var(--app-font-size)] font-serif h-0 resize-none bg-transparent select-text outline-none'
                                readOnly
                                value={result}
                            />
                        ) : (
                            <div>
                                {result['pronunciations'] &&
                                    result['pronunciations'].map((pronunciation, pronunciationIndex) => {
                                        return (
                                            <div key={pronunciationIndex}>
                                                {pronunciation['region'] && (
                                                    <span
                                                        className='text-[length:var(--app-font-size)] mr-[12px] text-default-500'
                                                    >
                                                        {pronunciation['region']}
                                                    </span>
                                                )}
                                                {pronunciation['symbol'] && (
                                                    <span
                                                        className='text-[length:var(--app-font-size)] mr-[12px] text-default-500'
                                                    >
                                                        {pronunciation['symbol']}
                                                    </span>
                                                )}
                                                {pronunciation['voice'] && pronunciation['voice'] !== '' && (
                                                    <HiOutlineVolumeUp
                                                        className='text-[length:var(--app-font-size)] inline-block my-auto cursor-pointer'
                                                        onClick={() => {
                                                            speak(pronunciation['voice']);
                                                        }}
                                                    />
                                                )}
                                            </div>
                                        );
                                    })}
                                {result['explanations'] &&
                                    result['explanations'].map((explanations, explanationIndex) => {
                                        return (
                                            <div key={explanationIndex}>
                                                {explanations['explains'] &&
                                                    explanations['explains'].map((explain, index) => {
                                                        return (
                                                            <span key={index}>
                                                                {index === 0 ? (
                                                                    <>
                                                                        <span
                                                                            className='text-[length:calc(var(--app-font-size)_-_2px)] text-default-500 mr-[12px]'
                                                                        >
                                                                            {explanations['trait']}
                                                                        </span>
                                                                        <span
                                                                            className='font-semibold text-[length:var(--app-font-size)] select-text'
                                                                        >
                                                                            {explain}
                                                                        </span>
                                                                        <br />
                                                                    </>
                                                                ) : (
                                                                    <span
                                                                        className='text-[length:calc(var(--app-font-size)_-_2px)] text-default-500 select-text mr-1'
                                                                    >
                                                                        {explain}
                                                                    </span>
                                                                )}
                                                            </span>
                                                        );
                                                    })}
                                            </div>
                                        );
                                    })}
                                <br />
                                {result['associations'] &&
                                    result['associations'].map((association, associationIndex) => {
                                        return (
                                            <div key={associationIndex}>
                                                <span className='text-[length:var(--app-font-size)] text-default-500'>
                                                    {association}
                                                </span>
                                            </div>
                                        );
                                    })}
                                {result['sentence'] &&
                                    result['sentence'].map((sentence, index) => {
                                        return (
                                            <div key={index}>
                                                <span className='text-[length:calc(var(--app-font-size)_-_2px)] mr-[12px]'>
                                                    {index + 1}.
                                                </span>
                                                <>
                                                    {sentence['source'] && (
                                                        <span
                                                            className='text-[length:var(--app-font-size)] select-text'
                                                            dangerouslySetInnerHTML={{
                                                                __html: sentence['source'],
                                                            }}
                                                        />
                                                    )}
                                                </>
                                                <>
                                                    {sentence['target'] && (
                                                        <div
                                                            className='text-[length:var(--app-font-size)] select-text text-default-500'
                                                            dangerouslySetInnerHTML={{
                                                                __html: sentence['target'],
                                                            }}
                                                        />
                                                    )}
                                                </>
                                            </div>
                                        );
                                    })}
                            </div>
                        )}
                        {error !== '' ? (
                            error.split('\n').map((v) => {
                                return (
                                    <p
                                        key={v}
                                        className='text-[length:var(--app-font-size)] font-sans text-danger'
                                    >
                                        {v}
                                    </p>
                                );
                            })
                        ) : (
                            <></>
                        )}
                    </CardBody>
                    <CardFooter
                        className='bg-content1 rounded-none flex px-[12px] p-[5px]'
                    >
                        <ButtonGroup>
                            {/* copy button */}
                            <Tooltip
                                delay={TOOLTIP_DELAY}
                                content={t('translate.copy')}
                            >
                                <Button
                                    isIconOnly
                                    variant='light'
                                    size='sm'
                                    isDisabled={typeof result !== 'string' || result === ''}
                                    onPress={() => {
                                        writeText(result);
                                    }}
                                >
                                    <MdContentCopy className='text-[16px]' />
                                </Button>
                            </Tooltip>
                            {/* translate back button */}
                            <Tooltip
                                delay={TOOLTIP_DELAY}
                                content={t('translate.translate_back')}
                            >
                                <Button
                                    isIconOnly
                                    variant='light'
                                    size='sm'
                                    isDisabled={typeof result !== 'string' || result === ''}
                                    onPress={async () => {
                                        setError('');
                                        let newTargetLanguage = sourceLanguage;
                                        if (sourceLanguage === 'auto') {
                                            newTargetLanguage = detectLanguage;
                                        }
                                        let newSourceLanguage = targetLanguage;
                                        if (sourceLanguage === 'auto') {
                                            newSourceLanguage = 'auto';
                                        }
                                        const LanguageEnum =
                                            builtinServices[getServiceName(currentTranslateServiceInstanceKey)]
                                                .Language;
                                        if (newSourceLanguage in LanguageEnum && newTargetLanguage in LanguageEnum) {
                                            setIsLoading(true);
                                            setHide(true);
                                            const instanceConfig =
                                                serviceInstanceConfigMap[currentTranslateServiceInstanceKey];
                                            const setHideOnce = invokeOnce(setHide);
                                            builtinServices[getServiceName(currentTranslateServiceInstanceKey)]
                                                .translate(
                                                    result.trim(),
                                                    LanguageEnum[newSourceLanguage],
                                                    LanguageEnum[newTargetLanguage],
                                                    {
                                                        config: instanceConfig,
                                                        detect: newSourceLanguage,
                                                        setResult: (v) => {
                                                            setResult(v);
                                                            setHideOnce(false);
                                                        },
                                                    }
                                                )
                                                .then(
                                                    (v) => {
                                                        if (v === result) {
                                                            setResult(v + ' ');
                                                        } else {
                                                            setResult(v.trim());
                                                        }
                                                        setIsLoading(false);
                                                        if (v !== '') {
                                                            setHideOnce(false);
                                                        }
                                                    },
                                                    (e) => {
                                                        setError(e.toString());
                                                        setIsLoading(false);
                                                    }
                                                );
                                        } else {
                                            setError('Language not supported');
                                        }
                                    }}
                                >
                                    <TbTransformFilled className='text-[16px]' />
                                </Button>
                            </Tooltip>
                            {/* error retry button */}
                            <Tooltip
                                delay={TOOLTIP_DELAY}
                                content={t('translate.retry')}
                            >
                                <Button
                                    isIconOnly
                                    variant='light'
                                    size='sm'
                                    className={`${error === '' && 'hidden'}`}
                                    onPress={() => {
                                        setError('');
                                        setResult('');
                                        translate();
                                    }}
                                >
                                    <GiCycle className='text-[16px]' />
                                </Button>
                            </Tooltip>
                        </ButtonGroup>
                    </CardFooter>
                </div>
            </div>
        </Card>
    );
}

// cards only re-render for their own result or when the shared props actually change
export default React.memo(TargetArea);
