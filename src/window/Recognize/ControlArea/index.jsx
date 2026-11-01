import { Dropdown, DropdownItem, DropdownMenu, DropdownTrigger, Button } from '@nextui-org/react';
import { atom, useAtom, useSetAtom } from 'jotai';
import { useTranslation } from 'react-i18next';
import { GiCycle } from 'react-icons/gi';
import React, { useEffect } from 'react';
import { nanoid } from 'nanoid';
import * as builtinService from '../../../services/recognize';
import { languageList } from '../../../utils/language';
import { useConfig } from '../../../hooks';
import { osType } from '../../../utils/env';
import { getServiceName, INSTANCE_NAME_CONFIG_KEY, getDisplayInstanceName } from '../../../utils/service_instance';
import { WINDOW_HIDE_EVENT } from '../../../utils/window';

export const currentServiceInstanceKeyAtom = atom();
export const languageAtom = atom();
export const recognizeFlagAtom = atom();

export default function ControlArea(props) {
    const { serviceInstanceConfigMap, serviceInstanceList } = props;
    const [recognizeLanguage] = useConfig('recognize_language', 'auto');
    const setRecognizeFlag = useSetAtom(recognizeFlagAtom);
    const [currentServiceInstanceKey, setCurrentServiceInstanceKey] = useAtom(currentServiceInstanceKeyAtom);
    const [language, setLanguage] = useAtom(languageAtom);
    const { t } = useTranslation();

    function getInstanceName(instanceKey, serviceNameSupplier) {
        const instanceConfig = serviceInstanceConfigMap[instanceKey] ?? {};
        return getDisplayInstanceName(instanceConfig[INSTANCE_NAME_CONFIG_KEY], serviceNameSupplier);
    }

    useEffect(() => {
        if (serviceInstanceList) {
            setCurrentServiceInstanceKey(serviceInstanceList[0]);
        }
        if (recognizeLanguage) {
            setLanguage(recognizeLanguage);
        }
    }, [serviceInstanceList, recognizeLanguage]);

    // the window is kept alive after being dismissed: start the next activation from the configured defaults
    useEffect(() => {
        const reset = () => {
            if (serviceInstanceList) {
                setCurrentServiceInstanceKey(serviceInstanceList[0]);
            }
            if (recognizeLanguage) {
                setLanguage(recognizeLanguage);
            }
        };
        window.addEventListener(WINDOW_HIDE_EVENT, reset);
        return () => {
            window.removeEventListener(WINDOW_HIDE_EVENT, reset);
        };
    }, [serviceInstanceList, recognizeLanguage]);

    return (
        <div className='flex justify-between px-[12px] h-full'>
            {currentServiceInstanceKey && (
                <Dropdown>
                    <DropdownTrigger>
                        <Button
                            className='my-auto'
                            variant='bordered'
                            size='sm'
                            startContent={
                                <img
                                    className='h-[16px] w-[16px] my-auto'
                                    src={
                                        builtinService[getServiceName(currentServiceInstanceKey)].info.icon === 'system'
                                            ? `logo/${osType}.svg`
                                            : builtinService[getServiceName(currentServiceInstanceKey)].info.icon
                                    }
                                />
                            }
                        >
                            {getInstanceName(currentServiceInstanceKey, () =>
                                t(`services.recognize.${currentServiceInstanceKey}.title`)
                            )}
                        </Button>
                    </DropdownTrigger>
                    <DropdownMenu
                        aria-label='service name'
                        className='max-h-[70vh] overflow-y-auto'
                        onAction={(key) => {
                            setCurrentServiceInstanceKey(key);
                        }}
                    >
                        {serviceInstanceList.map((instanceKey) => {
                            return (
                                <DropdownItem
                                    key={instanceKey}
                                    startContent={
                                        <img
                                            className='h-[16px] w-[16px] my-auto'
                                            src={
                                                builtinService[getServiceName(instanceKey)].info.icon === 'system'
                                                    ? `logo/${osType}.svg`
                                                    : builtinService[getServiceName(instanceKey)].info.icon
                                            }
                                        />
                                    }
                                >
                                    {getInstanceName(instanceKey, () => t(`services.recognize.${instanceKey}.title`))}
                                </DropdownItem>
                            );
                        })}
                    </DropdownMenu>
                </Dropdown>
            )}
            {language && (
                <Dropdown>
                    <DropdownTrigger>
                        <Button
                            className='my-auto'
                            variant='bordered'
                            size='sm'
                        >
                            {t(`languages.${language}`)}
                        </Button>
                    </DropdownTrigger>
                    <DropdownMenu
                        aria-label='language'
                        className='max-h-[70vh] overflow-y-auto'
                        onAction={(key) => {
                            setLanguage(key);
                        }}
                    >
                        <DropdownItem key='auto'>{t('languages.auto')}</DropdownItem>
                        {languageList.map((name) => {
                            return <DropdownItem key={name}>{t(`languages.${name}`)}</DropdownItem>;
                        })}
                    </DropdownMenu>
                </Dropdown>
            )}
            <Button
                variant='flat'
                color='secondary'
                size='sm'
                className='my-auto'
                startContent={<GiCycle className='text-[16px]' />}
                onPress={() => {
                    setRecognizeFlag(nanoid());
                }}
            >
                {t('recognize.recognize')}
            </Button>
        </div>
    );
}
