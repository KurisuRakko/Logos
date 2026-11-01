import { useTranslation } from 'react-i18next';
import { Tabs, Tab } from '@nextui-org/react';
import React from 'react';
import Translate from './Translate';
import Recognize from './Recognize';

export default function Service() {
    const { t } = useTranslation();

    return (
        <Tabs className='flex justify-center max-h-[calc(100%-40px)] overflow-y-auto'>
            <Tab
                key='translate'
                title={t(`config.service.translate`)}
            >
                <Translate />
            </Tab>
            <Tab
                key='recognize'
                title={t(`config.service.recognize`)}
            >
                <Recognize />
            </Tab>
        </Tabs>
    );
}
