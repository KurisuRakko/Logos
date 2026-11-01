export enum ServiceType {
    TRANSLATE = 'translate',
    RECOGNIZE = 'recognize',
}

// Plugin services were removed. Configs inherited from pot-desktop may still list
// instance keys starting with "plugin", so drop them whenever a service list is read.
export function filterServiceInstanceList(list: string[] | null, defaultList: string[]): string[] | null {
    if (list === null) {
        return null;
    }
    const filtered = list.filter((key) => !key.startsWith('plugin'));
    return filtered.length > 0 ? filtered : defaultList;
}

// The serviceInstanceKey consists of the service name and it's id, separated by @
// In earlier versions, the @ separator and id were optional, so they all have only one instance.
export function createServiceInstanceKey(serviceName: string): string {
    const randomId = Math.random().toString(36).substring(2);
    return `${serviceName}@${randomId}`;
}

export function getServiceName(serviceInstanceKey: string): string {
    return serviceInstanceKey.split('@')[0];
}

export function getDisplayInstanceName(instanceName: string, serviceNameSupplier: () => string): string {
    return instanceName || serviceNameSupplier();
}

export const INSTANCE_NAME_CONFIG_KEY = 'instanceName';
