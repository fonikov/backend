import { Injectable, Logger } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';

import { fail, ok, TResult } from '@common/types';
import { ERRORS } from '@libs/contracts/constants';

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
