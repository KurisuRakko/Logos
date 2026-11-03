import { Card, CardBody, Button, Progress, Spinner } from '@nextui-org/react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api';
import React, { useCallback, useEffect, useState } from 'react';

import { fetchLogosQuota, formatResetDate } from '../../../../utils/logos_account';
import { remoteLog } from '../../../../utils/remote_log';

export default function Account() {
    const { t } = useTranslation();
    // null while the first status check is running
    const [status, setStatus] = useState(null);
    const [statusError, setStatusError] = useState('');
    const [isLoggingIn, setIsLoggingIn] = useState(false);
    const [loginError, setLoginError] = useState('');
    const [quota, setQuota] = useState(null);
    const [quotaError, setQuotaError] = useState('');

    const loadQuota = useCallback(() => {
        setQuotaError('');
        fetchLogosQuota().then(
            (v) => setQuota(v),
            (e) => {
                setQuota(null);
                setQuotaError(e.message ?? String(e));
            }
        );
    }, []);

    const loadStatus = useCallback(() => {
        setStatusError('');
        invoke('logos_account_status').then(
            (v) => setStatus(v),
            (e) => {
                setStatus({ logged_in: false, user: null });
                setStatusError(String(e));
            }
        );
    }, []);

    useEffect(() => {
        loadStatus();
    }, []);

    useEffect(() => {
        if (status?.logged_in) {
            loadQuota();
        } else {
            setQuota(null);
        }
    }, [status?.logged_in]);

    const login = () => {
        setIsLoggingIn(true);
        setLoginError('');
        invoke('logos_account_login').then(
            (v) => {
                setIsLoggingIn(false);
                setStatusError('');
                setStatus(v);
            },
            (e) => {
                setIsLoggingIn(false);
                setLoginError(String(e));
                remoteLog('error', 'account_login_failed', String(e));
            }
        );
    };

    const logout = () => {
        invoke('logos_account_logout').finally(() => {
            setStatus({ logged_in: false, user: null });
        });
    };

    const user = status?.user;
    const displayName = user?.name || user?.preferred_username || user?.sub || t('config.account.unknown_user');
    const remainingPercent = quota ? Math.round(Math.min(Math.max(quota.remaining_ratio ?? 0, 0), 1) * 100) : 0;

    return (
        <>
            <Card
                shadow='none'
                className='mb-[10px] border-1 border-divider'
            >
                <CardBody>
                    {status === null ? (
                        <div className='flex justify-center py-[20px]'>
                            <Spinner size='sm' />
                        </div>
                    ) : status.logged_in ? (
                        <>
                            <div className='config-item'>
                                <h3 className='my-auto'>{t('config.account.user')}</h3>
                                <div className='my-auto text-right'>
                                    <div className='font-medium'>{displayName}</div>
                                    {user?.preferred_username && user.preferred_username !== displayName && (
                                        <div className='text-sm text-default-500'>{user.preferred_username}</div>
                                    )}
                                </div>
                            </div>
                            <div className='config-item'>
                                <div />
                                <Button
                                    variant='flat'
                                    color='danger'
                                    onPress={logout}
                                >
                                    {t('config.account.logout')}
                                </Button>
                            </div>
                        </>
                    ) : (
                        <>
                            <div className='config-item'>
                                <h3 className='my-auto'>{t('config.account.not_logged_in')}</h3>
                                <div className='flex gap-[8px]'>
                                    {isLoggingIn && (
                                        <Button
                                            variant='light'
                                            onPress={() => invoke('logos_account_cancel_login')}
                                        >
                                            {t('common.cancel')}
                                        </Button>
                                    )}
                                    <Button
                                        color='primary'
                                        isLoading={isLoggingIn}
                                        onPress={login}
                                    >
                                        {isLoggingIn ? t('config.account.waiting_browser') : t('config.account.login')}
                                    </Button>
                                </div>
                            </div>
                            <p className='text-sm text-default-500'>{t('config.account.login_description')}</p>
                            {(loginError || statusError) && (
                                <p className='text-sm text-danger mt-[8px]'>{loginError || statusError}</p>
                            )}
                        </>
                    )}
                </CardBody>
            </Card>
            {status?.logged_in && (
                <Card
                    shadow='none'
                    className='mb-[10px] border-1 border-divider'
                >
                    <CardBody>
                        <div className='config-item'>
                            <h3 className='my-auto'>{t('config.account.quota')}</h3>
                            <Button
                                size='sm'
                                variant='light'
                                onPress={loadQuota}
                            >
                                {t('config.account.refresh')}
                            </Button>
                        </div>
                        {quota ? (
                            <>
                                <Progress
                                    aria-label={t('config.account.quota')}
                                    size='md'
                                    radius='sm'
                                    value={remainingPercent}
                                    color={
                                        remainingPercent <= 10
                                            ? 'danger'
                                            : remainingPercent <= 30
                                              ? 'warning'
                                              : 'primary'
                                    }
                                    label={t('config.account.remaining')}
                                    showValueLabel
                                    classNames={{ label: 'text-sm', value: 'text-sm' }}
                                />
                                <p className='text-sm text-default-500 mt-[10px]'>
                                    {t('config.account.resets_at', { date: formatResetDate(quota.resets_at) })}
                                </p>
                            </>
                        ) : quotaError ? (
                            <p className='text-sm text-danger'>{quotaError}</p>
                        ) : (
                            <div className='flex justify-center py-[10px]'>
                                <Spinner size='sm' />
                            </div>
                        )}
                    </CardBody>
                </Card>
            )}
        </>
    );
}
