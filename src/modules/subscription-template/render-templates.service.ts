import { Injectable } from '@nestjs/common';

import { SubscriptionSettingsEntity } from '@modules/subscription-settings/entities/subscription-settings.entity';
import { HostWithRawInbound } from '@modules/hosts/entities/host-with-inbound-tag.entity';
import { ExternalSquadEntity } from '@modules/external-squads/entities';
import { UserEntity } from '@modules/users/entities';

import { XrayJsonGeneratorService } from './generators/xray-json.generator.service';
import { RawHostsGeneratorService } from './generators/raw-hosts.generator.service';
import { OutlineGeneratorService } from './generators/outline.generator.service';
import { SingBoxGeneratorService } from './generators/singbox.generator.service';
import { MihomoGeneratorService } from './generators/mihomo.generator.service';
import { ClashGeneratorService } from './generators/clash.generator.service';
import { XrayGeneratorService } from './generators/xray.generator.service';
import { FormatHostsService } from './generators/format-hosts.service';
import { SUBSCRIPTION_CONFIG_TYPES } from './constants/config-types';
import { IGenerateSubscription } from './interfaces';
import { IFormattedHost, IRawHost } from './generators/interfaces';

@Injectable()
export class RenderTemplatesService {
    constructor(
        private readonly formatHostsService: FormatHostsService,
        private readonly mihomoGeneratorService: MihomoGeneratorService,
        private readonly clashGeneratorService: ClashGeneratorService,
        private readonly outlineGeneratorService: OutlineGeneratorService,
        private readonly xrayGeneratorService: XrayGeneratorService,
        private readonly singBoxGeneratorService: SingBoxGeneratorService,
        private readonly xrayJsonGeneratorService: XrayJsonGeneratorService,
        private readonly rawHostsGeneratorService: RawHostsGeneratorService,
    ) {}

    public async generateSubscription(params: IGenerateSubscription): Promise<{
        contentType: string;
        subscription: string;
    }> {
        const { srrContext, user, hosts, hostsOverrides, fallbackOptions, additionalFormattedHosts } =
            params;

        const formattedHosts = await this.formatHostsService.generateFormattedHosts({
            subscriptionSettings: srrContext.subscriptionSettings,
            hosts,
            user,
            hostsOverrides,
            fallbackOptions,
        });
        const mergedHosts = [...formattedHosts, ...(additionalFormattedHosts || [])];

        switch (srrContext.matchedResponseType) {
            case 'XRAY_BASE64':
                return {
                    subscription: await this.xrayGeneratorService.generateConfig(
                        mergedHosts,
                        SUBSCRIPTION_CONFIG_TYPES['XRAY_BASE64'].isBase64,
                        srrContext.isXrayExtSupported,
                    ),
                    contentType: SUBSCRIPTION_CONFIG_TYPES['XRAY_BASE64'].CONTENT_TYPE,
                };

            case 'CLASH':
                return {
                    subscription: await this.clashGeneratorService.generateConfig(
                        mergedHosts,
                        srrContext.overrideTemplateName,
                    ),
                    contentType: SUBSCRIPTION_CONFIG_TYPES['CLASH'].CONTENT_TYPE,
                };

            case 'MIHOMO':
                return {
                    subscription: await this.mihomoGeneratorService.generateConfig(
                        mergedHosts,
                        false,
                        srrContext.isMihomoExtSupported,
                        srrContext.overrideTemplateName,
                    ),
                    contentType: SUBSCRIPTION_CONFIG_TYPES['MIHOMO'].CONTENT_TYPE,
                };

            case 'SINGBOX':
                return {
                    subscription: await this.singBoxGeneratorService.generateConfig(
                        mergedHosts,
                        srrContext.overrideTemplateName,
                    ),
                    contentType: SUBSCRIPTION_CONFIG_TYPES['SINGBOX'].CONTENT_TYPE,
                };

            case 'STASH':
                return {
                    subscription: await this.mihomoGeneratorService.generateConfig(
                        mergedHosts,
                        true,
                        false,
                        srrContext.overrideTemplateName,
                    ),
                    contentType: SUBSCRIPTION_CONFIG_TYPES['STASH'].CONTENT_TYPE,
                };

            case 'XRAY_JSON':
                return {
                    subscription: await this.xrayJsonGeneratorService.generateConfig({
                        hosts: mergedHosts,
                        isHapp: srrContext.isXrayExtSupported,
                        overrideTemplateName: srrContext.overrideTemplateName,
                        ignoreHostXrayJsonTemplate: srrContext.ignoreHostXrayJsonTemplate,
                    }),
                    contentType: SUBSCRIPTION_CONFIG_TYPES['XRAY_JSON'].CONTENT_TYPE,
                };

            default:
                return { subscription: '', contentType: '' };
        }
    }

    public async generateRawSubscription(params: {
        user: UserEntity;
        hosts: HostWithRawInbound[];
        hostsOverrides: ExternalSquadEntity['hostOverrides'] | undefined;
        subscriptionSettings: SubscriptionSettingsEntity;
        additionalFormattedHosts?: IFormattedHost[];
    }): Promise<{
        rawHosts: IRawHost[];
    }> {
        const { user, hosts, hostsOverrides, subscriptionSettings, additionalFormattedHosts } = params;

        const formattedHosts = await this.formatHostsService.generateFormattedHosts({
            subscriptionSettings,
            hosts,
            user,
            hostsOverrides,
            returnDbHost: true,
        });

        const rawHosts = await this.rawHostsGeneratorService.generateConfig([
            ...formattedHosts,
            ...(additionalFormattedHosts || []),
        ]);

        return {
            rawHosts,
        };
    }

    public async generateOutlineSubscription(
        subscriptionSettings: SubscriptionSettingsEntity | null,
        encodedTag: string,
        user: UserEntity,
        hosts: HostWithRawInbound[],
    ): Promise<{
        contentType: string;
        subscription: string;
    }> {
        const formattedHosts = await this.formatHostsService.generateFormattedHosts({
            subscriptionSettings,
            hosts,
            user,
        });

        return {
            subscription: this.outlineGeneratorService.generateConfig(formattedHosts, encodedTag),
            contentType: 'application/json',
        };
    }
}
