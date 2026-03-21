import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { Injectable, Logger } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';

import { fail, ok, TResult } from '@common/types';
import { ALPN, ERRORS, FINGERPRINTS, SECURITY_LAYERS } from '@libs/contracts/constants';
import { ImportHostCommand } from '@libs/contracts/commands';

import { GetSubscriptionTemplateByUuidQuery } from '@modules/subscription-template/queries/get-template-by-uuid';
import { GetConfigProfileByUuidQuery } from '@modules/config-profiles/queries/get-config-profile-by-uuid';
import { ExternalVlessService } from '@modules/external-vless/external-vless.service';
import { ReorderHostRequestDto } from '@modules/hosts/dtos/reorder-hosts.dto';

import { DeleteHostResponseModel } from './models/delete-host.response.model';
import { HostsRepository } from './repositories/hosts.repository';
import { CreateHostRequestDto } from './dtos/create-host.dto';
import { HostsEntity } from './entities/hosts.entity';
import { UpdateHostRequestDto } from './dtos';

@Injectable()
export class HostsService {
    private readonly logger = new Logger(HostsService.name);
    constructor(
        private readonly hostsRepository: HostsRepository,
        private readonly queryBus: QueryBus,
        private readonly externalVlessService: ExternalVlessService,
    ) {}

    public async createHost(dto: CreateHostRequestDto): Promise<TResult<HostsEntity>> {
        try {
            if (dto.xrayJsonTemplateUuid) {
                const xrayJsonTemplate = await this.queryBus.execute(
                    new GetSubscriptionTemplateByUuidQuery(dto.xrayJsonTemplateUuid),
                );

                if (!xrayJsonTemplate.isOk) {
                    return fail(ERRORS.SUBSCRIPTION_TEMPLATE_NOT_FOUND);
                }

                if (xrayJsonTemplate.response.templateType !== 'XRAY_JSON') {
                    return fail(ERRORS.TEMPLATE_TYPE_NOT_ALLOWED);
                }
            }

            let xHttpExtraParams: null | object | undefined;
            if (dto.xHttpExtraParams !== undefined && dto.xHttpExtraParams !== null) {
                xHttpExtraParams = dto.xHttpExtraParams;
            } else if (dto.xHttpExtraParams === null) {
                xHttpExtraParams = null;
            } else {
                xHttpExtraParams = undefined;
            }

            let muxParams: null | object | undefined;
            if (dto.muxParams !== undefined && dto.muxParams !== null) {
                if (Object.keys(dto.muxParams).length === 0) {
                    muxParams = null;
                } else {
                    muxParams = dto.muxParams;
                }
            } else if (dto.muxParams === null) {
                muxParams = null;
            } else {
                muxParams = undefined;
            }

            let sockoptParams: null | object | undefined;
            if (dto.sockoptParams !== undefined && dto.sockoptParams !== null) {
                if (Object.keys(dto.sockoptParams).length === 0) {
                    sockoptParams = null;
                } else {
                    sockoptParams = dto.sockoptParams;
                }
            } else if (dto.sockoptParams === null) {
                sockoptParams = null;
            } else {
                sockoptParams = undefined;
            }

            let serverDescription: null | string | undefined;
            if (dto.serverDescription !== undefined && dto.serverDescription !== null) {
                serverDescription = dto.serverDescription;
            } else if (dto.serverDescription === null) {
                serverDescription = null;
            } else {
                serverDescription = undefined;
            }

            const {
                inbound: inboundObj,
                nodes,
                excludedInternalSquads,
                readySubscription,
                sourceType,
                ...rest
            } = dto;

            const inboundResolution = await this.resolveInbound(inboundObj);
            if (!inboundResolution.isOk) {
                return inboundResolution;
            }

            const resolvedReadySubscription = readySubscription
                ? await this.externalVlessService.resolveReadySubscriptionSelectionInput(
                      readySubscription,
                  )
                : null;

            const hostEntity = new HostsEntity({
                ...rest,
                address: dto.address.trim(),
                xHttpExtraParams,
                muxParams,
                sockoptParams,
                configProfileUuid: inboundResolution.response.configProfileUuid,
                configProfileInboundUuid: inboundResolution.response.configProfileInboundUuid,
                serverDescription,
            });

            const result = await this.hostsRepository.create(hostEntity);

            const isReadySubscriptionHost =
                sourceType === 'READY_SUBSCRIPTION' || resolvedReadySubscription !== null;

            if (!isReadySubscriptionHost && nodes !== undefined && nodes.length > 0) {
                await this.hostsRepository.addNodesToHost(result.uuid, nodes);
                result.nodes = nodes.map((node) => {
                    return {
                        nodeUuid: node,
                    };
                });
            }

            if (excludedInternalSquads !== undefined && excludedInternalSquads.length > 0) {
                await this.hostsRepository.addExcludedInternalSquadsToHost(
                    result.uuid,
                    excludedInternalSquads,
                );
                result.excludedInternalSquads = excludedInternalSquads.map((squad) => {
                    return {
                        squadUuid: squad,
                    };
                });
            }

            if (resolvedReadySubscription) {
                await this.hostsRepository.setReadySubscriptionHost(
                    result.uuid,
                    resolvedReadySubscription,
                );
            }

            const [hydratedHost] = await this.attachReadySubscriptionData([result]);

            return ok(hydratedHost);
        } catch (error) {
            this.logger.error(error);

            return fail(ERRORS.CREATE_HOST_ERROR);
        }
    }

    public async updateHost(dto: UpdateHostRequestDto): Promise<TResult<HostsEntity>> {
        try {
            const {
                inbound: inboundObj,
                nodes,
                excludedInternalSquads,
                readySubscription,
                sourceType,
                ...rest
            } = dto;

            const host = await this.hostsRepository.findByUUID(dto.uuid);
            if (!host) return fail(ERRORS.HOST_NOT_FOUND);

            const existingReadySubscription = (
                await this.hostsRepository.findReadySubscriptionHostsByHostUuids([host.uuid])
            )[0];

            if (dto.xrayJsonTemplateUuid) {
                const xrayJsonTemplate = await this.queryBus.execute(
                    new GetSubscriptionTemplateByUuidQuery(dto.xrayJsonTemplateUuid),
                );

                if (!xrayJsonTemplate.isOk) {
                    return fail(ERRORS.SUBSCRIPTION_TEMPLATE_NOT_FOUND);
                }

                if (xrayJsonTemplate.response.templateType !== 'XRAY_JSON') {
                    return fail(ERRORS.TEMPLATE_TYPE_NOT_ALLOWED);
                }
            }

            let xHttpExtraParams: null | object | undefined;
            if (dto.xHttpExtraParams !== undefined && dto.xHttpExtraParams !== null) {
                xHttpExtraParams = dto.xHttpExtraParams;
            } else if (dto.xHttpExtraParams === null) {
                xHttpExtraParams = null;
            } else {
                xHttpExtraParams = undefined;
            }

            let muxParams: null | object | undefined;
            if (dto.muxParams !== undefined && dto.muxParams !== null) {
                if (Object.keys(dto.muxParams).length === 0) {
                    muxParams = null;
                } else {
                    muxParams = dto.muxParams;
                }
            } else if (dto.muxParams === null) {
                muxParams = null;
            } else {
                muxParams = undefined;
            }

            let sockoptParams: null | object | undefined;
            if (dto.sockoptParams !== undefined && dto.sockoptParams !== null) {
                if (Object.keys(dto.sockoptParams).length === 0) {
                    sockoptParams = null;
                } else {
                    sockoptParams = dto.sockoptParams;
                }
            } else if (dto.sockoptParams === null) {
                sockoptParams = null;
            } else {
                sockoptParams = undefined;
            }

            let serverDescription: null | string | undefined;
            if (dto.serverDescription !== undefined && dto.serverDescription !== null) {
                serverDescription = dto.serverDescription;
            } else if (dto.serverDescription === null) {
                serverDescription = null;
            } else {
                serverDescription = undefined;
            }

            let configProfileUuid: string | undefined;
            let configProfileInboundUuid: string | undefined;
            if (inboundObj) {
                const inboundResolution = await this.resolveInbound(inboundObj);
                if (!inboundResolution.isOk) {
                    return inboundResolution;
                }

                configProfileUuid = inboundResolution.response.configProfileUuid;
                configProfileInboundUuid = inboundResolution.response.configProfileInboundUuid;
            }

            const resolvedReadySubscription = readySubscription?.selectedNodes
                ? await this.externalVlessService.resolveReadySubscriptionSelectionInput(
                      {
                          ...readySubscription,
                          selectedNodes: readySubscription.selectedNodes,
                      },
                  )
                : null;

            const isReadySubscriptionHost =
                sourceType === 'READY_SUBSCRIPTION' ||
                resolvedReadySubscription !== null ||
                Boolean(existingReadySubscription);

            if (isReadySubscriptionHost) {
                await this.hostsRepository.clearNodesFromHost(host.uuid);
            } else if (nodes !== undefined) {
                await this.hostsRepository.clearNodesFromHost(host.uuid);
                await this.hostsRepository.addNodesToHost(host.uuid, nodes);
            }

            if (excludedInternalSquads !== undefined) {
                await this.hostsRepository.clearExcludedInternalSquadsFromHost(host.uuid);
                await this.hostsRepository.addExcludedInternalSquadsToHost(
                    host.uuid,
                    excludedInternalSquads,
                );
            }

            const result = await this.hostsRepository.update({
                ...rest,
                address: dto.address ? dto.address.trim() : undefined,
                xHttpExtraParams,
                muxParams,
                sockoptParams,
                configProfileUuid,
                configProfileInboundUuid,
                serverDescription,
            });

            if (resolvedReadySubscription) {
                await this.hostsRepository.setReadySubscriptionHost(
                    result.uuid,
                    resolvedReadySubscription,
                );
            } else if (existingReadySubscription && sourceType === 'MANUAL') {
                await this.hostsRepository.deleteReadySubscriptionHost(result.uuid);
            }

            const [hydratedHost] = await this.attachReadySubscriptionData([result]);

            return ok(hydratedHost);
        } catch (error) {
            this.logger.error(error);

            return fail(ERRORS.UPDATE_HOST_ERROR);
        }
    }

    public async deleteHost(hostUuid: string): Promise<TResult<DeleteHostResponseModel>> {
        try {
            const host = await this.hostsRepository.findByUUID(hostUuid);
            if (!host) {
                return fail(ERRORS.HOST_NOT_FOUND);
            }
            const result = await this.hostsRepository.deleteByUUID(host.uuid);

            return ok(new DeleteHostResponseModel({ isDeleted: result }));
        } catch (error) {
            this.logger.error(error);
            this.logger.error(JSON.stringify(error));
            return fail(ERRORS.DELETE_HOST_ERROR);
        }
    }

    public async getAllHosts(): Promise<TResult<HostsEntity[]>> {
        try {
            const result = await this.hostsRepository.findAll();

            return ok(await this.attachReadySubscriptionData(result));
        } catch (error) {
            this.logger.error(JSON.stringify(error));
            return fail(ERRORS.GET_ALL_HOSTS_ERROR);
        }
    }

    public async getOneHost(hostUuid: string): Promise<TResult<HostsEntity>> {
        try {
            const result = await this.hostsRepository.findByUUID(hostUuid);

            if (!result) {
                return fail(ERRORS.HOST_NOT_FOUND);
            }

            const [hydratedHost] = await this.attachReadySubscriptionData([result]);

            return ok(hydratedHost);
        } catch (error) {
            this.logger.error(error);
            return fail(ERRORS.GET_ONE_HOST_ERROR);
        }
    }

    public async reorderHosts(dto: ReorderHostRequestDto): Promise<
        TResult<{
            isUpdated: boolean;
        }>
    > {
        try {
            const result = await this.hostsRepository.reorderMany(dto.hosts);

            return ok({ isUpdated: result });
        } catch (error) {
            this.logger.error(error);
            return fail(ERRORS.REORDER_HOSTS_ERROR);
        }
    }

    public async deleteHosts(uuids: string[]): Promise<TResult<HostsEntity[]>> {
        try {
            await this.hostsRepository.deleteMany(uuids);

            const result = await this.getAllHosts();

            if (!result.isOk) {
                return fail(ERRORS.DELETE_HOSTS_ERROR);
            }

            return ok(result.response);
        } catch (error) {
            this.logger.error(error);
            return fail(ERRORS.DELETE_HOSTS_ERROR);
        }
    }

    public async bulkEnableHosts(uuids: string[]): Promise<TResult<HostsEntity[]>> {
        try {
            await this.hostsRepository.enableMany(uuids);

            const result = await this.getAllHosts();

            if (!result.isOk) {
                return fail(ERRORS.BULK_ENABLE_HOSTS_ERROR);
            }

            return ok(result.response);
        } catch (error) {
            this.logger.error(error);
            return fail(ERRORS.BULK_ENABLE_HOSTS_ERROR);
        }
    }

    public async bulkDisableHosts(uuids: string[]): Promise<TResult<HostsEntity[]>> {
        try {
            await this.hostsRepository.disableMany(uuids);

            const result = await this.getAllHosts();

            if (!result.isOk) {
                return fail(ERRORS.BULK_DISABLE_HOSTS_ERROR);
            }

            return ok(result.response);
        } catch (error) {
            this.logger.error(error);
            return fail(ERRORS.BULK_DISABLE_HOSTS_ERROR);
        }
    }

    public async setInboundToHosts(
        uuids: string[],
        configProfileUuid: string,
        configProfileInboundUuid: string,
    ): Promise<TResult<HostsEntity[]>> {
        try {
            const configProfile = await this.queryBus.execute(
                new GetConfigProfileByUuidQuery(configProfileUuid),
            );

            if (!configProfile.isOk) {
                return fail(ERRORS.CONFIG_PROFILE_NOT_FOUND);
            }

            const configProfileInbound = configProfile.response.inbounds.find(
                (inbound) => inbound.uuid === configProfileInboundUuid,
            );

            if (!configProfileInbound) {
                return fail(ERRORS.CONFIG_PROFILE_INBOUND_NOT_FOUND_IN_SPECIFIED_PROFILE);
            }

            await this.hostsRepository.setInboundToManyHosts(
                uuids,
                configProfileUuid,
                configProfileInboundUuid,
            );

            const result = await this.getAllHosts();

            if (!result.isOk) {
                return fail(ERRORS.SET_INBOUND_TO_HOSTS_ERROR);
            }

            if (!result.isOk) {
                return fail(ERRORS.SET_INBOUND_TO_HOSTS_ERROR);
            }

            return ok(result.response);
        } catch (error) {
            this.logger.error(error);
            return fail(ERRORS.SET_INBOUND_TO_HOSTS_ERROR);
        }
    }

    public async setPortToHosts(uuids: string[], port: number): Promise<TResult<HostsEntity[]>> {
        try {
            await this.hostsRepository.setPortToManyHosts(uuids, port);

            const result = await this.getAllHosts();

            if (!result.isOk) {
                return fail(ERRORS.SET_PORT_TO_HOSTS_ERROR);
            }

            return ok(result.response);
        } catch (error) {
            this.logger.error(error);
            return fail(ERRORS.SET_PORT_TO_HOSTS_ERROR);
        }
    }

    public async getAllHostTags(): Promise<TResult<string[]>> {
        try {
            const result = await this.hostsRepository.getAllHostTags();

            return ok(result);
        } catch (error) {
            this.logger.error(error);
            return fail(ERRORS.GET_ALL_HOST_TAGS_ERROR);
        }
    }

    public async importHostInput(
        dto: ImportHostCommand.Request,
    ): Promise<TResult<ImportHostCommand.Response['response']>> {
        try {
            const parsed =
                dto.format === 'VLESS_URI'
                    ? await this.parseVlessUri(dto.input)
                    : await this.parseXrayJson(dto.input);

            return ok(parsed);
        } catch (error) {
            this.logger.warn(
                `Failed to import host input: ${error instanceof Error ? error.message : String(error)}`,
            );

            return fail(
                ERRORS.INVALID_HOST_IMPORT_INPUT.withMessage(
                    error instanceof Error ? error.message : 'Failed to import host input',
                ),
            );
        }
    }

    private async resolveInbound(inboundObj: {
        configProfileInboundUuid: string;
        configProfileUuid: string;
    }): Promise<
        TResult<{
            configProfileInboundUuid: string;
            configProfileUuid: string;
        }>
    > {
        const configProfile = await this.queryBus.execute(
            new GetConfigProfileByUuidQuery(inboundObj.configProfileUuid),
        );

        if (!configProfile.isOk) {
            return fail(ERRORS.CONFIG_PROFILE_NOT_FOUND);
        }

        const configProfileInbound = configProfile.response.inbounds.find(
            (inbound) => inbound.uuid === inboundObj.configProfileInboundUuid,
        );
        if (!configProfileInbound) {
            return fail(ERRORS.CONFIG_PROFILE_INBOUND_NOT_FOUND_IN_SPECIFIED_PROFILE);
        }

        return ok({
            configProfileUuid: configProfile.response.uuid,
            configProfileInboundUuid: configProfileInbound.uuid,
        });
    }

    private async parseVlessUri(
        input: string,
    ): Promise<ImportHostCommand.Response['response']> {
        const normalized = input.trim();
        if (!normalized.toLowerCase().startsWith('vless://')) {
            throw new Error('VLESS URI must start with vless://');
        }

        const url = new URL(normalized);
        const params = url.searchParams;
        const address = await this.resolveHostAddress(url.hostname);
        const transport = (params.get('type') || 'tcp').toLowerCase().trim();
        const security = (params.get('security') || 'none').toLowerCase().trim();
        const host = params.get('host') || params.get('authority');
        const rawAlpn = params.get('alpn')?.split(',')[0]?.trim() || null;
        const rawFingerprint =
            params.get('fp')?.trim() || params.get('fingerprint')?.trim() || null;
        const insecure = params.get('allowInsecure') || params.get('insecure');

        return {
            remark: this.decodeRemark(url.hash.replace(/^#/, '')) || null,
            address,
            port: Number(url.port || 443),
            path:
                transport === 'grpc'
                    ? params.get('serviceName') || params.get('path') || null
                    : params.get('path') || null,
            sni: params.get('sni') || null,
            host: host || null,
            alpn: this.parseEnumValue(ALPN, rawAlpn),
            fingerprint: this.parseEnumValue(FINGERPRINTS, rawFingerprint),
            allowInsecure: insecure === '1' || insecure === 'true',
            securityLayer: this.mapSecurityLayer(security),
        };
    }

    private async parseXrayJson(
        input: string,
    ): Promise<ImportHostCommand.Response['response']> {
        let parsedConfig: any;

        try {
            parsedConfig = JSON.parse(input);
        } catch {
            throw new Error('Xray JSON is not valid JSON');
        }

        const vlessOutbound = parsedConfig?.outbounds?.find(
            (outbound: any) => outbound?.protocol === 'vless',
        );
        if (!vlessOutbound) {
            throw new Error('Xray JSON must contain at least one vless outbound');
        }

        const vnext = vlessOutbound?.settings?.vnext?.[0];
        const user = vnext?.users?.[0];
        const streamSettings = vlessOutbound?.streamSettings || {};
        const tlsSettings = streamSettings?.tlsSettings || {};
        const realitySettings = streamSettings?.realitySettings || {};
        const wsSettings = streamSettings?.wsSettings || {};
        const grpcSettings = streamSettings?.grpcSettings || {};
        const httpSettings = streamSettings?.httpSettings || {};
        const httpupgradeSettings = streamSettings?.httpupgradeSettings || {};
        const xhttpSettings = streamSettings?.xhttpSettings || {};

        if (!vnext?.address || !vnext?.port || !user?.id) {
            throw new Error('Xray JSON vless outbound is missing address, port, or user id');
        }

        const address = await this.resolveHostAddress(String(vnext.address));
        const security = String(streamSettings?.security || 'none').toLowerCase().trim();
        const network = String(streamSettings?.network || 'tcp').toLowerCase().trim();
        const rawAlpn = Array.isArray(tlsSettings?.alpn)
            ? tlsSettings.alpn[0]
            : tlsSettings?.alpn || null;
        const rawFingerprint =
            realitySettings?.fingerprint || tlsSettings?.fingerprint || null;
        const hostHeader =
            wsSettings?.headers?.Host ||
            httpupgradeSettings?.host ||
            httpSettings?.host ||
            xhttpSettings?.host ||
            null;

        return {
            remark: typeof parsedConfig?.remarks === 'string' ? parsedConfig.remarks : null,
            address,
            port: Number(vnext.port),
            path:
                network === 'grpc'
                    ? grpcSettings?.serviceName || null
                    : wsSettings?.path ||
                      httpupgradeSettings?.path ||
                      xhttpSettings?.path ||
                      httpSettings?.path ||
                      null,
            sni: realitySettings?.serverName || tlsSettings?.serverName || null,
            host: hostHeader,
            alpn: this.parseEnumValue(ALPN, typeof rawAlpn === 'string' ? rawAlpn : null),
            fingerprint: this.parseEnumValue(
                FINGERPRINTS,
                typeof rawFingerprint === 'string' ? rawFingerprint : null,
            ),
            allowInsecure: Boolean(tlsSettings?.allowInsecure),
            securityLayer: this.mapSecurityLayer(security),
        };
    }

    private async resolveHostAddress(address: string): Promise<string> {
        const normalizedAddress = address.trim();

        if (!normalizedAddress) {
            throw new Error('Address is required');
        }

        if (isIP(normalizedAddress)) {
            return normalizedAddress;
        }

        try {
            const resolved = await lookup(normalizedAddress);
            return resolved.address;
        } catch {
            throw new Error(`Failed to resolve address "${normalizedAddress}" to an IP`);
        }
    }

    private mapSecurityLayer(
        security: string,
    ): (typeof SECURITY_LAYERS)[keyof typeof SECURITY_LAYERS] {
        if (security === 'tls') {
            return SECURITY_LAYERS.TLS;
        }

        if (security === 'none') {
            return SECURITY_LAYERS.NONE;
        }

        return SECURITY_LAYERS.DEFAULT;
    }

    private parseEnumValue<T extends Record<string, string>>(
        enumLike: T,
        value: null | string,
    ): null | T[keyof T] {
        if (!value) {
            return null;
        }

        return Object.values(enumLike).includes(value as T[keyof T])
            ? (value as T[keyof T])
            : null;
    }

    private decodeRemark(input: string): string {
        try {
            return decodeURIComponent(input).trim();
        } catch {
            return input.trim();
        }
    }

    private async attachReadySubscriptionData(hosts: HostsEntity[]): Promise<HostsEntity[]> {
        if (hosts.length === 0) {
            return hosts;
        }

        const readySubscriptions = await this.hostsRepository.findReadySubscriptionHostsByHostUuids(
            hosts.map((host) => host.uuid),
        );
        const readyStateMap =
            await this.externalVlessService.buildReadySubscriptionStates(readySubscriptions);

        return hosts.map((host) => {
            const readySubscription = readyStateMap.get(host.uuid) || null;
            host.sourceType = readySubscription ? 'READY_SUBSCRIPTION' : 'MANUAL';
            host.readySubscription = readySubscription;

            return host;
        });
    }
}
