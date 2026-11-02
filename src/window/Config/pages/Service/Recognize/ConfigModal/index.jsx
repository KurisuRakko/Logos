import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Button, Spacer } from '@nextui-org/react';

import { useTranslation } from 'react-i18next';
import React from 'react';

import { getServiceName } from '../../../../../../utils/service_instance';
import * as builtinServices from '../../../../../../services/recognize';
import * as serviceConfigs from '../../../../../../services/recognize/config';
import { osType } from '../../../../../../utils/env';

export default function ConfigModal(props) {
    const { serviceInstanceKey, isOpen, onOpenChange, updateServiceInstanceList } = props;

    const serviceName = getServiceName(serviceInstanceKey);

    const { t } = useTranslation();
    const ConfigComponent = serviceConfigs[serviceName];

    return (
        <Modal
            isOpen={isOpen}
            onOpenChange={onOpenChange}
            scrollBehavior='inside'
        >
            <ModalContent className='max-h-[75vh]'>
                {(onClose) => (
                    <>
                        <ModalHeader>
                            <img
                                src={
                                    serviceName === 'system'
                                        ? `logo/${osType}.svg`
                                        : builtinServices[serviceName].info.icon
                                }
                                className='h-[24px] w-[24px] my-auto'
                                draggable={false}
                            />
                            <Spacer x={2} />
                            {t(`services.recognize.${serviceName}.title`)}
                        </ModalHeader>
                        <ModalBody>
                            <ConfigComponent
                                name={serviceName}
                                instanceKey={serviceInstanceKey}
                                updateServiceList={updateServiceInstanceList}
                                onClose={onClose}
                            />
                        </ModalBody>
                        <ModalFooter>
                            <Button
                                color='danger'
                                variant='light'
                                onPress={onClose}
                            >
                                {t('common.cancel')}
                            </Button>
                        </ModalFooter>
                    </>
                )}
            </ModalContent>
        </Modal>
    );
}
