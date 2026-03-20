import { Hosts } from '@prisma/client';

import {
    SUBSCRIPTION_TEMPLATE_TYPE_VALUES,
    TSecurityLayers,
    TSubscriptionTemplateType,
} from '@contract/constants';

export type THostSourceType = 'MANUAL' | 'READY_SUBSCRIPTION';

export type ReadySubscriptionResolvedNode = {
    bridgeLabel: string;
    countryCode: null | string;
    countryLabel: string;
    dedupeKey: string;
    displayName: string;
    effectiveTags: string[];
    isAlive: boolean;
    isAutoReplacement: boolean;
    isPinned: boolean;
    latencyMs: null | number;
    originalRemark: string;
    uuid: null | string;
};

export type ReadySubscriptionHostState = {
    activeNodeLimit: number;
    activeNodes: ReadySubscriptionResolvedNode[];
    autoReplace: boolean;
    presetName: string;
    presetSlug: string;
    presetUuid: string;
    selectedNodes: ReadySubscriptionResolvedNode[];
};

export class HostsEntity implements Hosts {
    uuid: string;
    viewPosition: number;
    remark: string;
    address: string;
    port: number;
    path: null | string;
    sni: null | string;
    host: null | string;
    alpn: null | string;
    fingerprint: null | string;
    securityLayer: TSecurityLayers;
    xHttpExtraParams: null | object;
    muxParams: null | object;
    sockoptParams: null | object;
    isDisabled: boolean;
    serverDescription: null | string;
    allowInsecure: boolean;

    tag: null | string;
    isHidden: boolean;

    overrideSniFromAddress: boolean;
    keepSniBlank: boolean;
    vlessRouteId: number | null;
    shuffleHost: boolean;
    mihomoX25519: boolean;

    configProfileUuid: string | null;
    configProfileInboundUuid: string | null;

    xrayJsonTemplateUuid: string | null;
    excludeFromSubscriptionTypes: TSubscriptionTemplateType[];
    sourceType: THostSourceType;
    readySubscription: null | ReadySubscriptionHostState;

    nodes: {
        nodeUuid: string;
    }[];

    excludedInternalSquads: {
        squadUuid: string;
    }[];

    constructor(data: Partial<Hosts>) {
        Object.assign(this, data);

        this.sourceType = 'MANUAL';
        this.readySubscription = null;

        if (data.excludeFromSubscriptionTypes) {
            this.excludeFromSubscriptionTypes = data.excludeFromSubscriptionTypes.filter(
                (v): v is TSubscriptionTemplateType =>
                    SUBSCRIPTION_TEMPLATE_TYPE_VALUES.includes(v as TSubscriptionTemplateType),
            );
        }
    }
}
