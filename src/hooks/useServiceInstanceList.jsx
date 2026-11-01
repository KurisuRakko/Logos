import { useMemo } from 'react';
import { useConfig } from './useConfig';
import { filterServiceInstanceList } from '../utils/service_instance';

// useConfig for translate_service_list / recognize_service_list with leftover plugin keys removed
export const useServiceInstanceList = (key, defaultValue, options = {}) => {
    const [property, setProperty, getProperty] = useConfig(key, defaultValue, options);
    const list = useMemo(() => filterServiceInstanceList(property, defaultValue), [property]);

    return [list, setProperty, getProperty];
};
