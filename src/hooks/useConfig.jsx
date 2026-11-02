import { useCallback, useEffect } from 'react';
import { listen, emit } from '@tauri-apps/api/event';
import { useGetState } from './useGetState';
import { store, getSnapshot, setSnapshot } from '../utils/store';
import { debounce } from '../utils';

export const useConfig = (key, defaultValue, options = {}) => {
    const [property, setPropertyState, getProperty] = useGetState(() => getSnapshot(key) ?? defaultValue);
    const { sync = true } = options;

    // 同步到Store (State -> Store)
    const syncToStore = useCallback(
        debounce((v) => {
            setSnapshot(key, v);
            store.set(key, v);
            store.save();
            let eventKey = key.replaceAll('.', '_').replaceAll('@', ':');
            emit(`${eventKey}_changed`, v);
        }),
        []
    );

    // 同步到State (Store -> State)
    const syncToState = useCallback((v) => {
        if (v !== null) {
            setSnapshot(key, v);
            setPropertyState(v);
        } else {
            store.get(key).then((v) => {
                if (v === null) {
                    setSnapshot(key, defaultValue);
                    setPropertyState(defaultValue);
                    store.set(key, defaultValue);
                    store.save();
                } else {
                    setSnapshot(key, v);
                    setPropertyState(v);
                }
            });
        }
    }, []);

    const setProperty = useCallback((v, forceSync = false) => {
        setPropertyState(v);
        const isSync = forceSync || sync;
        isSync && syncToStore(v);
    }, []);

    // 初始化：值已从快照同步取得，缺键时补写默认值
    useEffect(() => {
        if (getSnapshot(key) === null) {
            setSnapshot(key, defaultValue);
            store.set(key, defaultValue);
            store.save();
        }
        const eventKey = key.replaceAll('.', '_').replaceAll('@', ':');
        const unlisten = listen(`${eventKey}_changed`, (e) => {
            syncToState(e.payload);
        });
        return () => {
            unlisten.then((f) => {
                f();
            });
        };
    }, []);

    return [property, setProperty, getProperty];
};

export const deleteKey = (key) => {
    if (store.has(key)) {
        setSnapshot(key, null);
        store.delete(key);
        store.save();
    }
};
