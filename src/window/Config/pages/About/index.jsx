import { Divider, Button } from '@nextui-org/react';
import { appLogDir, appConfigDir } from '@tauri-apps/api/path';
import { useTranslation } from 'react-i18next';
import { open } from '@tauri-apps/api/shell';
import React from 'react';

import { appVersion } from '../../../../utils/env';

export default function About() {
    const { t } = useTranslation();

    return (
        <div className='h-full w-full py-[80px] px-[100px]'>
            <img
                src='icon.png'
                className='mx-auto h-[100px] mb-[5px]'
                draggable={false}
            />
            <div className='content-center'>
                <h1 className='font-semibold text-2xl text-center'>Logos</h1>
                <p className='text-center text-sm text-gray-500 mb-[5px]'>{appVersion}</p>
                <Divider />
                <div className='flex justify-between'>
                    <Button
                        variant='light'
                        className='my-[5px]'
                        size='sm'
                        onPress={() => {
                            open('https://github.com/KurisuRakko/Logos');
                        }}
                    >
                        {t('config.about.github')}
                    </Button>
                    <Button
                        variant='light'
                        className='my-[5px]'
                        size='sm'
                        onPress={() => {
                            open('https://github.com/KurisuRakko/Logos/issues');
                        }}
                    >
                        {t('config.about.issue')}
                    </Button>
                </div>
                <Divider />
            </div>
            <div className='content-center px-[40px]'>
                <div className='flex justify-between'>
                    <Button
                        variant='light'
                        className='my-[5px]'
                        size='sm'
                        onPress={async () => {
                            const dir = await appLogDir();
                            open(dir);
                        }}
                    >
                        {t('config.about.view_log')}
                    </Button>
                    <Button
                        variant='light'
                        className='my-[5px]'
                        size='sm'
                        onPress={async () => {
                            const dir = await appConfigDir();
                            open(dir);
                        }}
                    >
                        {t('config.about.view_config')}
                    </Button>
                </div>

                <Divider />
            </div>
        </div>
    );
}
