import { useTranslation } from 'react-i18next';
import { Button } from '@nextui-org/react';
import React from 'react';

import { useConfig } from '../../../hooks/useConfig';
import { INSTANCE_NAME_CONFIG_KEY } from '../../../utils/service_instance';

export function Config(props) {
    const { instanceKey, updateServiceList, onClose } = props;
    const { t } = useTranslation();
    const [logosAiConfig, setLogosAiConfig] = useConfig(
        instanceKey,
        {
            [INSTANCE_NAME_CONFIG_KEY]: t('services.translate.logos_ai.title'),
        },
        { sync: false }
    );

    return (
        logosAiConfig !== null && (
            <>
                <div>{t('services.translate.logos_ai.description')}</div>
                <div>
                    <Button
                        fullWidth
                        onPress={() => {
                            setLogosAiConfig(logosAiConfig, true);
                            updateServiceList(instanceKey);
                            onClose();
                        }}
                    >
                        {t('common.save')}
                    </Button>
                </div>
            </>
        )
    );
}
