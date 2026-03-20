import { lookup } from 'node:dns/promises';
import { createHash } from 'node:crypto';
import { isIP, Socket } from 'node:net';

import axios from 'axios';
import geoip from 'geoip-lite';
import pMap from 'p-map';

import { TransactionalAdapterPrisma } from '@nestjs-cls/transactional-adapter-prisma';
import { TransactionHost } from '@nestjs-cls/transactional';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import {
    HostsEntity,
    ReadySubscriptionHostState,
    ReadySubscriptionResolvedNode,
} from '@modules/hosts/entities/hosts.entity';
import { IFormattedHost } from '@modules/subscription-template/generators/interfaces';
import { UserEntity } from '@modules/users/entities';

type TCountryMode = 'ANY' | 'NON_RU_ONLY' | 'RU_ONLY';

type ParsedExternalVless = {
    address: string;
    alpn: string;
    authority: null | string;
    credential: string;
    dedupeKey: string;
    displayCountry: null | string;
    encryption: string;
    fingerprint: string;
    flow: '' | 'xtls-rprx-vision';
    host: string;
    network: string;
    originalRemark: string;
    path: string;
    port: number;
    publicKey: string;
    rawUri: string;
    remarkTags: string[];
    security: string;
    serviceName: string;
    shortId: string;
    sni: string;
    sourcePosition: number;
    spiderX: string;
};

type ProbedExternalVless = ParsedExternalVless & {
    countryCode: null | string;
    countryName: null | string;
    isAlive: boolean;
    latencyMs: null | number;
    resolvedAddress: null | string;
};

type ExternalPresetSeed = {
    countryMode: TCountryMode;
    includeKeywords: string[];
    name: string;
    requiredSecurity: null | string;
    selectionLimit: number;
    slug: string;
    sourceUrls: string[];
    uniqueCountries: boolean;
};

type ExternalNodeRecord = {
    aliasRemark: null | string;
    alpn: null | string;
    authority: null | string;
    countryCode: null | string;
    countryName: null | string;
    credential: string;
    customTags: string[];
    dedupeKey: string;
    displayCountry: null | string;
    address: string;
    encryption: null | string;
    fingerprint: null | string;
    flow: null | string;
    host: null | string;
    isAlive: boolean;
    isEnabled: boolean;
    isManual: boolean;
    isPinned: boolean;
    latencyMs: null | number;
    network: string;
    originalRemark: string;
    path: null | string;
    port: number;
    priority: number;
    publicKey: null | string;
    rawUri: string;
    remarkTags: string[];
    resolvedAddress: null | string;
    security: string;
    serviceName: null | string;
    shortId: null | string;
    sourcePosition: number;
    sni: null | string;
    spiderX: null | string;
    uuid: string;
};

type ReadySubscriptionSelectionInput = {
    activeNodeLimit?: number;
    autoReplace?: boolean;
    presetUuid: string;
    selectedNodes: {
        isPinned?: boolean;
        nodeUuid: string;
    }[];
};

type ReadySubscriptionRelationRecord = {
    activeNodeLimit: number;
    autoReplace: boolean;
    hostUuid: string;
    nodes: {
        dedupeKey: string;
        isPinned: boolean;
        viewPosition: number;
    }[];
    preset: {
        countryMode: string;
        name: string;
        selectionLimit: number;
        slug: string;
        uniqueCountries: boolean;
        uuid: string;
    };
};

const WHITE_SOURCE_URLS = [
    'https://raw.githubusercontent.com/igareck/vpn-configs-for-russia/refs/heads/main/Vless-Reality-White-Lists-Rus-Mobile.txt',
    'https://raw.githubusercontent.com/igareck/vpn-configs-for-russia/refs/heads/main/Vless-Reality-White-Lists-Rus-Mobile-2.txt',
    'https://raw.githubusercontent.com/igareck/vpn-configs-for-russia/refs/heads/main/WHITE-CIDR-RU-all.txt',
    'https://raw.githubusercontent.com/igareck/vpn-configs-for-russia/refs/heads/main/WHITE-CIDR-RU-checked.txt',
    'https://raw.githubusercontent.com/igareck/vpn-configs-for-russia/refs/heads/main/WHITE-SNI-RU-all.txt',
    'https://raw.githubusercontent.com/AvenCores/goida-vpn-configs/refs/heads/main/githubmirror/26.txt',
];

const DEFAULT_PRESETS: ExternalPresetSeed[] = [
    {
        slug: 'auto-black',
        name: 'Auto server BLACK',
        sourceUrls: [
            'https://raw.githubusercontent.com/igareck/vpn-configs-for-russia/refs/heads/main/BLACK_VLESS_RUS.txt',
            'https://raw.githubusercontent.com/igareck/vpn-configs-for-russia/refs/heads/main/BLACK_VLESS_RUS_mobile.txt',
        ],
        includeKeywords: ['BL'],
        requiredSecurity: null,
        selectionLimit: 5,
        countryMode: 'ANY',
        uniqueCountries: true,
    },
    {
        slug: 'auto-white-ru-ip',
        name: 'Auto server White List with RU IP',
        sourceUrls: WHITE_SOURCE_URLS,
        includeKeywords: [],
        requiredSecurity: 'reality',
        selectionLimit: 5,
        countryMode: 'RU_ONLY',
        uniqueCountries: false,
    },
    {
        slug: 'auto-white-foreign-ip',
        name: 'Auto server White List with Foreign IP',
        sourceUrls: WHITE_SOURCE_URLS,
        includeKeywords: [],
        requiredSecurity: 'reality',
        selectionLimit: 5,
        countryMode: 'NON_RU_ONLY',
        uniqueCountries: false,
    },
];

@Injectable()
export class ExternalVlessService implements OnModuleInit {
    private readonly logger = new Logger(ExternalVlessService.name);

    constructor(private readonly prisma: TransactionHost<TransactionalAdapterPrisma>) {}

    public async onModuleInit(): Promise<void> {
        await this.ensureDefaultPresets();
    }

    public async ensureDefaultPresets(): Promise<void> {
        for (const preset of DEFAULT_PRESETS) {
            await this.prisma.tx.externalVlessPreset.upsert({
                where: { slug: preset.slug },
                create: preset,
                update: {
                    countryMode: preset.countryMode,
                    includeKeywords: preset.includeKeywords,
                    name: preset.name,
                    requiredSecurity: preset.requiredSecurity,
                    selectionLimit: preset.selectionLimit,
                    sourceUrls: preset.sourceUrls,
                    uniqueCountries: preset.uniqueCountries,
                },
            });
        }
    }

    public async getPresetsWithNodes() {
        await this.ensureDefaultPresets();

        const presets = await this.prisma.tx.externalVlessPreset.findMany({
            orderBy: {
                viewPosition: 'asc',
            },
            include: {
                nodes: {
                    orderBy: [
                        { isPinned: 'desc' },
                        { isAlive: 'desc' },
                        { latencyMs: 'asc' },
                        { priority: 'desc' },
                        { sourcePosition: 'asc' },
                    ],
                },
            },
        });

        return presets.map((preset) => {
            const enabledNodes = preset.nodes.filter((node) => node.isEnabled);
            const selectedNodeIds = new Set(
                this.selectNodesForPreset(preset, enabledNodes).map((node) => node.uuid),
            );

            const nodes = [...preset.nodes]
                .sort((a, b) => {
                    const selectedDelta =
                        Number(selectedNodeIds.has(b.uuid)) - Number(selectedNodeIds.has(a.uuid));

                    if (selectedDelta !== 0) {
                        return selectedDelta;
                    }

                    const enabledDelta = Number(b.isEnabled) - Number(a.isEnabled);
                    if (enabledDelta !== 0) {
                        return enabledDelta;
                    }

                    return this.compareNodes(a, b);
                })
                .map((node) => ({
                    ...node,
                    bridgeLabel: this.getBridgeLabel(node),
                    countryLabel: this.getCountryLabel(node),
                    displayName: this.getNodeDisplayName(preset.name, node),
                    effectiveTags: this.getEffectiveTags(preset.slug, node),
                    isSelectedForSubscription: selectedNodeIds.has(node.uuid),
                }));

            return {
                ...preset,
                availableCountries: this.getAvailableCountries(preset.nodes),
                nodes,
                selectedNodesCount: selectedNodeIds.size,
                totalNodesCount: preset.nodes.length,
            };
        });
    }

    public async syncAllPresets() {
        await this.ensureDefaultPresets();

        const presets = await this.prisma.tx.externalVlessPreset.findMany({
            orderBy: {
                viewPosition: 'asc',
            },
        });

        const synced = await pMap(
            presets,
            async (preset) => ({
                slug: preset.slug,
                synced: (await this.syncPreset(preset.uuid)).synced,
            }),
            { concurrency: 2 },
        );

        return {
            synced,
        };
    }

    public async reprobeAllNodes() {
        const nodes = await this.prisma.tx.externalVlessNode.findMany({
            where: {
                isEnabled: true,
            },
            select: {
                address: true,
                uuid: true,
            },
        });

        await pMap(
            nodes,
            async (node) => {
                const health = await this.getNodeHealth(node.address, null);
                await this.prisma.tx.externalVlessNode.update({
                    where: {
                        uuid: node.uuid,
                    },
                    data: {
                        countryCode: health.countryCode,
                        countryName: health.countryName,
                        isAlive: health.isAlive,
                        lastCheckedAt: new Date(),
                        latencyMs: health.latencyMs,
                        resolvedAddress: health.resolvedAddress,
                    },
                });
            },
            { concurrency: 20 },
        );

        return {
            reprobed: nodes.length,
        };
    }

    public async syncPreset(uuid: string): Promise<{ synced: number }> {
        const preset = await this.prisma.tx.externalVlessPreset.findUnique({
            where: { uuid },
        });

        if (!preset) {
            throw new Error('External VLESS preset not found');
        }

        const fetchedSources = await pMap(
            preset.sourceUrls,
            async (sourceUrl, sourceIndex) => {
                const response = await axios.get<string>(sourceUrl, {
                    responseType: 'text',
                    timeout: 20000,
                });

                return this.parseSource(
                    response.data,
                    preset.includeKeywords,
                    preset.requiredSecurity,
                    sourceIndex * 10_000,
                );
            },
            { concurrency: 3 },
        );

        const parsedNodes = this.dedupeNodes(fetchedSources.flat());

        const probedNodes = await pMap(
            parsedNodes,
            async (node) => {
                const health = await this.getNodeHealth(node.address, node.port);

                return {
                    ...node,
                    countryCode: health.countryCode,
                    countryName: health.countryName,
                    isAlive: health.isAlive,
                    latencyMs: health.latencyMs,
                    resolvedAddress: health.resolvedAddress,
                };
            },
            { concurrency: 20 },
        );

        const existingAutoNodes = await this.prisma.tx.externalVlessNode.findMany({
            where: {
                presetUuid: preset.uuid,
                isManual: false,
            },
            select: {
                aliasRemark: true,
                customTags: true,
                dedupeKey: true,
                isEnabled: true,
                isPinned: true,
                priority: true,
            },
        });
        const existingAutoNodeMap = new Map(
            existingAutoNodes.map((node) => [node.dedupeKey, node] as const),
        );

        await this.prisma.withTransaction(async () => {
            await this.prisma.tx.externalVlessNode.deleteMany({
                where: {
                    isManual: false,
                    presetUuid: preset.uuid,
                },
            });

            if (probedNodes.length > 0) {
                await this.prisma.tx.externalVlessNode.createMany({
                    data: probedNodes.map((node) => {
                        const existingNode = existingAutoNodeMap.get(node.dedupeKey);

                        return {
                            address: node.address,
                            aliasRemark: existingNode?.aliasRemark || null,
                            alpn: node.alpn || null,
                            authority: node.authority || null,
                            countryCode: node.countryCode,
                            countryName: node.countryName,
                            credential: node.credential,
                            customTags: existingNode?.customTags ?? [],
                            dedupeKey: node.dedupeKey,
                            displayCountry: node.displayCountry,
                            encryption: node.encryption || null,
                            fingerprint: node.fingerprint || null,
                            flow: node.flow || null,
                            host: node.host || null,
                            isAlive: node.isAlive,
                            isEnabled: existingNode?.isEnabled ?? true,
                            isManual: false,
                            isPinned: existingNode?.isPinned ?? false,
                            lastCheckedAt: new Date(),
                            latencyMs: node.latencyMs,
                            originalRemark: node.originalRemark,
                            path: node.path || null,
                            port: node.port,
                            presetUuid: preset.uuid,
                            priority: existingNode?.priority ?? 0,
                            publicKey: node.publicKey || null,
                            rawUri: node.rawUri,
                            remarkTags: node.remarkTags,
                            resolvedAddress: node.resolvedAddress,
                            security: node.security,
                            serviceName: node.serviceName || null,
                            shortId: node.shortId || null,
                            sni: node.sni || null,
                            sourcePosition: node.sourcePosition,
                            spiderX: node.spiderX || null,
                        };
                    }),
                });
            }

            await this.prisma.tx.externalVlessPreset.update({
                where: { uuid: preset.uuid },
                data: {
                    lastSyncedAt: new Date(),
                },
            });
        });

        return {
            synced: probedNodes.length,
        };
    }

    public async updatePreset(
        uuid: string,
        body: {
            isEnabled?: boolean;
            name?: string;
            selectionLimit?: number;
        },
    ) {
        return this.prisma.tx.externalVlessPreset.update({
            where: { uuid },
            data: {
                ...(body.name !== undefined ? { name: body.name.trim() } : {}),
                ...(body.isEnabled !== undefined ? { isEnabled: body.isEnabled } : {}),
                ...(body.selectionLimit !== undefined
                    ? { selectionLimit: Math.max(1, Math.min(50, body.selectionLimit)) }
                    : {}),
            },
        });
    }

    public async updateNode(
        uuid: string,
        body: {
            aliasRemark?: null | string;
            customTags?: string[];
            isEnabled?: boolean;
            isPinned?: boolean;
            priority?: number;
        },
    ) {
        return this.prisma.tx.externalVlessNode.update({
            where: { uuid },
            data: {
                ...(body.aliasRemark !== undefined
                    ? { aliasRemark: body.aliasRemark?.trim() || null }
                    : {}),
                ...(body.customTags !== undefined
                    ? { customTags: this.normalizeTagList(body.customTags) }
                    : {}),
                ...(body.isEnabled !== undefined ? { isEnabled: body.isEnabled } : {}),
                ...(body.isPinned !== undefined ? { isPinned: body.isPinned } : {}),
                ...(body.priority !== undefined ? { priority: body.priority } : {}),
            },
        });
    }

    public async createManualNode(
        presetUuid: string,
        body: {
            aliasRemark?: string;
            customTags?: string[];
            priority?: number;
            rawUri: string;
        },
    ) {
        const preset = await this.prisma.tx.externalVlessPreset.findUnique({
            where: { uuid: presetUuid },
        });

        if (!preset) {
            throw new Error('External VLESS preset not found');
        }

        const parsed = this.parseSingleUri(body.rawUri, 0);
        const health = await this.getNodeHealth(parsed.address, parsed.port);

        return this.prisma.tx.externalVlessNode.create({
            data: {
                address: parsed.address,
                aliasRemark: body.aliasRemark?.trim() || null,
                alpn: parsed.alpn || null,
                authority: parsed.authority || null,
                countryCode: health.countryCode,
                countryName: health.countryName,
                credential: parsed.credential,
                customTags: this.normalizeTagList(body.customTags || []),
                dedupeKey: parsed.dedupeKey,
                displayCountry: parsed.displayCountry,
                encryption: parsed.encryption || null,
                fingerprint: parsed.fingerprint || null,
                flow: parsed.flow || null,
                host: parsed.host || null,
                isAlive: health.isAlive,
                isManual: true,
                lastCheckedAt: new Date(),
                latencyMs: health.latencyMs,
                originalRemark: parsed.originalRemark,
                path: parsed.path || null,
                port: parsed.port,
                presetUuid,
                priority: body.priority ?? 0,
                publicKey: parsed.publicKey || null,
                rawUri: parsed.rawUri,
                remarkTags: parsed.remarkTags,
                resolvedAddress: health.resolvedAddress,
                security: parsed.security,
                serviceName: parsed.serviceName || null,
                shortId: parsed.shortId || null,
                sni: parsed.sni || null,
                sourcePosition: 0,
                spiderX: parsed.spiderX || null,
            },
        });
    }

    public async resolveReadySubscriptionSelectionInput(
        input: ReadySubscriptionSelectionInput,
    ): Promise<{
        activeNodeLimit: number;
        autoReplace: boolean;
        presetUuid: string;
        selectedNodes: {
            dedupeKey: string;
            isPinned: boolean;
        }[];
    }> {
        const preset = await this.prisma.tx.externalVlessPreset.findUnique({
            where: {
                uuid: input.presetUuid,
            },
            select: {
                uuid: true,
            },
        });

        if (!preset) {
            throw new Error('External VLESS preset not found');
        }

        const selectedNodes = await this.prisma.tx.externalVlessNode.findMany({
            where: {
                presetUuid: input.presetUuid,
                uuid: {
                    in: input.selectedNodes.map((node) => node.nodeUuid),
                },
            },
            select: {
                dedupeKey: true,
                uuid: true,
            },
        });

        const selectedNodeMap = new Map(selectedNodes.map((node) => [node.uuid, node] as const));

        const normalizedSelectedNodes = input.selectedNodes
            .map((node) => {
                const resolvedNode = selectedNodeMap.get(node.nodeUuid);

                if (!resolvedNode) {
                    throw new Error(`External VLESS node ${node.nodeUuid} not found`);
                }

                return {
                    dedupeKey: resolvedNode.dedupeKey,
                    isPinned: Boolean(node.isPinned),
                };
            })
            .filter(
                (node, index, array) =>
                    array.findIndex((item) => item.dedupeKey === node.dedupeKey) === index,
            );

        if (normalizedSelectedNodes.length === 0) {
            throw new Error('At least one external VLESS node must be selected');
        }

        return {
            presetUuid: input.presetUuid,
            autoReplace: input.autoReplace ?? true,
            activeNodeLimit: Math.max(
                1,
                Math.min(10, input.activeNodeLimit ?? normalizedSelectedNodes.length),
            ),
            selectedNodes: normalizedSelectedNodes,
        };
    }

    public async buildReadySubscriptionStates(
        relations: ReadySubscriptionRelationRecord[],
    ): Promise<Map<string, ReadySubscriptionHostState>> {
        const result = new Map<string, ReadySubscriptionHostState>();

        if (relations.length === 0) {
            return result;
        }

        const presetUuidSet = new Set<string>(
            relations.map((relation: ReadySubscriptionRelationRecord) => relation.preset.uuid),
        );
        const presetNodes = await this.prisma.tx.externalVlessNode.findMany({
            where: {
                presetUuid: {
                    in: [...presetUuidSet],
                },
            },
            orderBy: [
                { isPinned: 'desc' },
                { isAlive: 'desc' },
                { latencyMs: 'asc' },
                { priority: 'desc' },
                { sourcePosition: 'asc' },
            ],
        });

        const nodesByPreset = new Map<string, ExternalNodeRecord[]>();
        for (const node of presetNodes) {
            const list = nodesByPreset.get(node.presetUuid) || [];
            list.push(node);
            nodesByPreset.set(node.presetUuid, list);
        }

        for (const relation of relations) {
            const presetPool = nodesByPreset.get(relation.preset.uuid) || [];
            const selectedNodes = this.buildSelectedReadyNodes(relation, presetPool);
            const activeNodes = this.buildActiveReadyNodes(relation, presetPool, selectedNodes);

            result.set(relation.hostUuid, {
                presetUuid: relation.preset.uuid,
                presetName: relation.preset.name,
                presetSlug: relation.preset.slug,
                autoReplace: relation.autoReplace,
                activeNodeLimit: relation.activeNodeLimit,
                selectedNodes,
                activeNodes,
            });
        }

        return result;
    }

    public async getFormattedHostsForReadyHosts(
        hosts: HostsEntity[],
        _user: UserEntity,
    ): Promise<IFormattedHost[]> {
        if (hosts.length === 0) {
            return [];
        }

        const relations = await this.prisma.tx.readySubscriptionHost.findMany({
            where: {
                hostUuid: {
                    in: hosts.map((host) => host.uuid),
                },
            },
            include: {
                preset: {
                    select: {
                        countryMode: true,
                        name: true,
                        selectionLimit: true,
                        slug: true,
                        uniqueCountries: true,
                        uuid: true,
                    },
                },
                nodes: {
                    orderBy: {
                        viewPosition: 'asc',
                    },
                },
            },
        });

        const readyStateMap = await this.buildReadySubscriptionStates(relations);
        const hostMap = new Map(hosts.map((host) => [host.uuid, host] as const));
        const presetUuidSet = new Set(relations.map((relation) => relation.preset.uuid));
        const presetNodes = await this.prisma.tx.externalVlessNode.findMany({
            where: {
                presetUuid: {
                    in: [...presetUuidSet],
                },
            },
        });
        const nodesByPreset = new Map<string, ExternalNodeRecord[]>();
        for (const node of presetNodes) {
            const list = nodesByPreset.get(node.presetUuid) || [];
            list.push(node);
            nodesByPreset.set(node.presetUuid, list);
        }

        return relations.flatMap((relation: ReadySubscriptionRelationRecord) => {
            const host = hostMap.get(relation.hostUuid);
            const readyState = readyStateMap.get(relation.hostUuid);
            if (!host || !readyState) {
                return [];
            }

            const presetPool = nodesByPreset.get(relation.preset.uuid) || [];

            return readyState.activeNodes.flatMap((node, index) => {
                const nodeRecord =
                    presetPool.find((poolNode) => poolNode.uuid === node.uuid) ||
                    presetPool.find((poolNode) => poolNode.dedupeKey === node.dedupeKey);

                if (!nodeRecord) {
                    return [];
                }

                return this.toFormattedReadyHost(host, readyState, nodeRecord, index);
            });
        });
    }

    public async getFormattedHostsForUser(_user: UserEntity): Promise<IFormattedHost[]> {
        const presets = await this.prisma.tx.externalVlessPreset.findMany({
            where: {
                isEnabled: true,
            },
            orderBy: {
                viewPosition: 'asc',
            },
            include: {
                nodes: {
                    where: {
                        isEnabled: true,
                    },
                    orderBy: [
                        { isPinned: 'desc' },
                        { isAlive: 'desc' },
                        { latencyMs: 'asc' },
                        { priority: 'desc' },
                        { sourcePosition: 'asc' },
                    ],
                },
            },
        });

        return presets.flatMap((preset) =>
            this.selectNodesForPreset(preset, preset.nodes).map((node) =>
                this.toFormattedHost(preset.name, node),
            ),
        );
    }

    private selectNodesForPreset(
        preset: {
            countryMode: string;
            selectionLimit: number;
            uniqueCountries: boolean;
        },
        nodes: ExternalNodeRecord[],
    ): ExternalNodeRecord[] {
        const filteredNodes = nodes.filter((node) => this.matchCountryMode(node, preset.countryMode));
        const onlineNodes = filteredNodes.filter((node) => node.isAlive);
        const orderedNodes = (onlineNodes.length > 0 ? onlineNodes : filteredNodes).sort((a, b) =>
            this.compareNodes(a, b),
        );

        if (!preset.uniqueCountries) {
            return orderedNodes.slice(0, preset.selectionLimit);
        }

        const selected: ExternalNodeRecord[] = [];
        const usedCountries = new Set<string>();

        for (const node of orderedNodes) {
            const countryKey = (
                node.displayCountry ||
                node.countryName ||
                node.countryCode ||
                node.originalRemark
            ).trim();

            if (usedCountries.has(countryKey)) {
                continue;
            }

            usedCountries.add(countryKey);
            selected.push(node);

            if (selected.length >= preset.selectionLimit) {
                return selected;
            }
        }

        for (const node of orderedNodes) {
            if (selected.some((selectedNode) => selectedNode.uuid === node.uuid)) {
                continue;
            }

            selected.push(node);

            if (selected.length >= preset.selectionLimit) {
                break;
            }
        }

        return selected;
    }

    private compareNodes(a: ExternalNodeRecord, b: ExternalNodeRecord): number {
        if (a.isPinned !== b.isPinned) {
            return Number(b.isPinned) - Number(a.isPinned);
        }

        if (a.isAlive !== b.isAlive) {
            return Number(b.isAlive) - Number(a.isAlive);
        }

        const latencyA = a.latencyMs ?? Number.MAX_SAFE_INTEGER;
        const latencyB = b.latencyMs ?? Number.MAX_SAFE_INTEGER;

        if (latencyA !== latencyB) {
            return latencyA - latencyB;
        }

        if (a.priority !== b.priority) {
            return b.priority - a.priority;
        }

        return a.port - b.port;
    }

    private matchCountryMode(node: ExternalNodeRecord, countryMode: string): boolean {
        switch (countryMode as TCountryMode) {
            case 'RU_ONLY':
                return node.countryCode === 'RU';
            case 'NON_RU_ONLY':
                return node.countryCode !== 'RU';
            default:
                return true;
        }
    }

    private toFormattedHost(presetName: string, node: ExternalNodeRecord): IFormattedHost {
        return {
            address: node.address,
            alpn: node.alpn || '',
            encryption: node.encryption || 'none',
            fingerprint: node.fingerprint || 'chrome',
            flow: node.flow === 'xtls-rprx-vision' ? 'xtls-rprx-vision' : '',
            host: node.host || node.authority || '',
            network: node.network as IFormattedHost['network'],
            password: {
                ssPassword: '',
                trojanPassword: '',
                vlessPassword: node.credential,
            },
            path: node.network === 'grpc' ? node.serviceName || '' : node.path || '',
            port: node.port,
            protocol: 'vless',
            publicKey: node.publicKey || '',
            remark:
                node.aliasRemark ||
                `${presetName} / ${node.displayCountry || node.countryCode || 'AUTO'} / ${node.originalRemark}`,
            shortId: node.shortId || '',
            sni: node.sni || '',
            spiderX: node.spiderX || '',
            tls: node.security || 'none',
            serviceInfo: {
                excludeFromSubscriptionTypes: [],
                isHidden: false,
                tag: `external:${presetName}`,
                uuid: node.uuid,
            },
        };
    }

    private buildSelectedReadyNodes(
        relation: ReadySubscriptionRelationRecord,
        presetPool: ExternalNodeRecord[],
    ): ReadySubscriptionResolvedNode[] {
        const poolByDedupeKey = new Map(presetPool.map((node) => [node.dedupeKey, node] as const));

        return [...relation.nodes]
            .sort((a, b) => {
                if (a.isPinned !== b.isPinned) {
                    return Number(b.isPinned) - Number(a.isPinned);
                }

                return a.viewPosition - b.viewPosition;
            })
            .map((selectedNode) =>
                this.toResolvedReadyNode(
                    relation.preset.slug,
                    poolByDedupeKey.get(selectedNode.dedupeKey) || null,
                    selectedNode.dedupeKey,
                    selectedNode.isPinned,
                    false,
                ),
            );
    }

    private buildActiveReadyNodes(
        relation: ReadySubscriptionRelationRecord,
        presetPool: ExternalNodeRecord[],
        selectedNodes: ReadySubscriptionResolvedNode[],
    ): ReadySubscriptionResolvedNode[] {
        const selectedDedupeKeys = new Set(selectedNodes.map((node) => node.dedupeKey));
        const enabledPool = presetPool
            .filter((node) => node.isEnabled)
            .sort((a, b) => this.compareNodes(a, b));
        const enabledSelectedDedupeKeys = new Set(enabledPool.map((node) => node.dedupeKey));
        const replacementPool = enabledPool.filter((node) => !selectedDedupeKeys.has(node.dedupeKey));
        const usedReplacementDedupeKeys = new Set<string>();
        const activeNodes: ReadySubscriptionResolvedNode[] = [];
        const seen = new Set<string>();

        const pushNode = (node: ReadySubscriptionResolvedNode) => {
            if (seen.has(node.dedupeKey)) {
                return;
            }

            seen.add(node.dedupeKey);
            activeNodes.push(node);
        };

        const takeReplacementFor = (
            sourceNode: ReadySubscriptionResolvedNode,
        ): ExternalNodeRecord | null => {
            const availableAlive = replacementPool.filter(
                (node) => node.isAlive && !usedReplacementDedupeKeys.has(node.dedupeKey),
            );

            if (availableAlive.length === 0) {
                return null;
            }

            const sourceCountryKey = this.getResolvedCountryKey(sourceNode);
            let replacement =
                sourceCountryKey !== null
                    ? availableAlive.find(
                          (node) => this.getExternalNodeCountryKey(node) === sourceCountryKey,
                      ) || null
                    : null;

            if (!replacement) {
                replacement = availableAlive[0];
            }

            usedReplacementDedupeKeys.add(replacement.dedupeKey);
            return replacement;
        };

        for (const selectedNode of selectedNodes) {
            if (activeNodes.length >= relation.activeNodeLimit) {
                break;
            }

            if (!enabledSelectedDedupeKeys.has(selectedNode.dedupeKey)) {
                continue;
            }

            if (selectedNode.isAlive || !relation.autoReplace) {
                pushNode(selectedNode);
                continue;
            }

            const replacement = takeReplacementFor(selectedNode);

            if (replacement) {
                pushNode(
                    this.toResolvedReadyNode(
                        relation.preset.slug,
                        replacement,
                        replacement.dedupeKey,
                        false,
                        true,
                    ),
                );
            } else {
                pushNode(selectedNode);
            }
        }

        if (activeNodes.length >= relation.activeNodeLimit || !relation.autoReplace) {
            return activeNodes.slice(0, relation.activeNodeLimit);
        }

        for (const replacement of replacementPool) {
            if (activeNodes.length >= relation.activeNodeLimit) {
                break;
            }

            if (!replacement.isAlive || usedReplacementDedupeKeys.has(replacement.dedupeKey)) {
                continue;
            }

            pushNode(
                this.toResolvedReadyNode(
                    relation.preset.slug,
                    replacement,
                    replacement.dedupeKey,
                    false,
                    true,
                ),
            );
            usedReplacementDedupeKeys.add(replacement.dedupeKey);
        }

        return activeNodes.slice(0, relation.activeNodeLimit);
    }

    private getExternalNodeCountryKey(
        node: Pick<ExternalNodeRecord, 'countryCode' | 'countryName' | 'displayCountry'>,
    ): null | string {
        const raw = node.countryCode || node.displayCountry || node.countryName || '';
        const normalized = raw.trim().toUpperCase();

        return normalized || null;
    }

    private getResolvedCountryKey(node: ReadySubscriptionResolvedNode): null | string {
        const raw = node.countryCode || node.countryLabel || '';
        const normalized = raw.trim().toUpperCase();

        return normalized || null;
    }

    private toResolvedReadyNode(
        presetSlug: string,
        node: ExternalNodeRecord | null,
        dedupeKey: string,
        isPinned: boolean,
        isAutoReplacement: boolean,
    ): ReadySubscriptionResolvedNode {
        if (!node) {
            return {
                uuid: null,
                dedupeKey,
                displayName: 'Недоступный сервер',
                originalRemark: 'Недоступный сервер',
                countryCode: null,
                countryLabel: 'Не определена',
                latencyMs: null,
                isAlive: false,
                isPinned,
                isAutoReplacement,
                bridgeLabel: 'UNKNOWN',
                effectiveTags: this.getPresetTags(presetSlug),
            };
        }

        return {
            uuid: node.uuid,
            dedupeKey: node.dedupeKey,
            displayName: this.getNodeDisplayName('Ready Host', node),
            originalRemark: node.originalRemark,
            countryCode: node.countryCode,
            countryLabel: this.getCountryLabel(node),
            latencyMs: node.latencyMs,
            isAlive: node.isAlive,
            isPinned,
            isAutoReplacement,
            bridgeLabel: this.getBridgeLabel(node),
            effectiveTags: this.getEffectiveTags(presetSlug, node),
        };
    }

    private toFormattedReadyHost(
        host: HostsEntity,
        readyState: ReadySubscriptionHostState,
        node: ExternalNodeRecord,
        index: number,
    ): IFormattedHost {
        const remarkSuffix =
            readyState.activeNodes.length > 1 ? ` ^~${index + 1}~^` : '';

        return {
            address: node.address,
            alpn: node.alpn || '',
            allowInsecure: host.allowInsecure,
            dbData: {
                rawInbound: null,
                inboundTag: 'ready-subscription',
                uuid: host.uuid,
                configProfileUuid: host.configProfileUuid,
                configProfileInboundUuid: host.configProfileInboundUuid,
                isDisabled: host.isDisabled,
                viewPosition: host.viewPosition,
                remark: host.remark,
                isHidden: host.isHidden,
                tag: host.tag,
                vlessRouteId: host.vlessRouteId,
            },
            encryption: node.encryption || 'none',
            fingerprint: node.fingerprint || 'chrome',
            flow: node.flow === 'xtls-rprx-vision' ? 'xtls-rprx-vision' : '',
            host: node.host || node.authority || '',
            mihomoX25519: host.mihomoX25519,
            muxParams: host.muxParams,
            network: node.network as IFormattedHost['network'],
            password: {
                ssPassword: '',
                trojanPassword: '',
                vlessPassword: node.credential,
            },
            path: node.network === 'grpc' ? node.serviceName || '' : node.path || '',
            port: node.port,
            protocol: 'vless',
            publicKey: node.publicKey || '',
            remark: `${host.remark}${remarkSuffix}`,
            serverDescription: host.serverDescription
                ? Buffer.from(host.serverDescription).toString('base64')
                : undefined,
            serviceInfo: {
                uuid: host.uuid,
                isHidden: host.isHidden,
                tag: host.tag,
                excludeFromSubscriptionTypes: host.excludeFromSubscriptionTypes,
            },
            shortId: node.shortId || '',
            shuffleHost: host.shuffleHost,
            sni: node.sni || '',
            sockoptParams: host.sockoptParams,
            spiderX: node.spiderX || '',
            tls: node.security || 'none',
            xHttpExtraParams: host.xHttpExtraParams,
        };
    }

    private getAvailableCountries(nodes: ExternalNodeRecord[]) {
        return [...new Set(nodes.map((node) => this.getCountryLabel(node)).filter(Boolean))];
    }

    private getCountryLabel(node: Pick<ExternalNodeRecord, 'countryCode' | 'countryName' | 'displayCountry'>): string {
        return (
            node.displayCountry ||
            node.countryName ||
            node.countryCode ||
            'Unknown'
        );
    }

    private getNodeDisplayName(presetName: string, node: ExternalNodeRecord): string {
        return (
            node.aliasRemark ||
            `${presetName} / ${this.getCountryLabel(node)} / ${node.originalRemark}`
        );
    }

    private getBridgeLabel(node: Pick<ExternalNodeRecord, 'network' | 'remarkTags' | 'security'>): string {
        const parts = [
            node.security !== 'none' ? node.security.toUpperCase() : null,
            node.network ? node.network.toUpperCase() : null,
            node.remarkTags[0] || null,
        ].filter(Boolean);

        return parts.join(' / ') || 'DEFAULT';
    }

    private getPresetTags(slug: string): string[] {
        switch (slug) {
            case 'auto-black':
                return ['BLACK'];
            case 'auto-white-ru-ip':
                return ['WHITE-RU'];
            case 'auto-white-foreign-ip':
                return ['WHITE-FOREIGN'];
            default:
                return ['EXTERNAL'];
        }
    }

    private getEffectiveTags(slug: string, node: Pick<ExternalNodeRecord, 'countryCode' | 'customTags' | 'isManual' | 'network' | 'remarkTags' | 'security'>): string[] {
        return this.normalizeTagList([
            ...this.getPresetTags(slug),
            ...node.remarkTags,
            ...node.customTags,
            node.countryCode || '',
            node.network,
            node.security,
            node.isManual ? 'MANUAL' : 'AUTO',
        ]);
    }

    private normalizeTagList(tags: string[]): string[] {
        return [...new Set(tags.map((tag) => tag.trim().toUpperCase()).filter(Boolean))];
    }

    private dedupeNodes(nodes: ParsedExternalVless[]): ParsedExternalVless[] {
        const dedupedNodes = new Map<string, ParsedExternalVless>();

        for (const node of nodes) {
            const existingNode = dedupedNodes.get(node.dedupeKey);

            if (!existingNode || node.sourcePosition < existingNode.sourcePosition) {
                dedupedNodes.set(node.dedupeKey, node);
            }
        }

        return [...dedupedNodes.values()];
    }

    private parseSource(
        source: string,
        includeKeywords: string[],
        requiredSecurity: null | string,
        sourceOffset: number,
    ): ParsedExternalVless[] {
        return this.extractVlessUris(source)
            .map((line, index) => this.parseSingleUri(line, sourceOffset + index))
            .filter((node) => {
                if (requiredSecurity && node.security !== requiredSecurity) {
                    return false;
                }

                if (includeKeywords.length === 0) {
                    return true;
                }

                return includeKeywords.some((keyword) =>
                    node.remarkTags.includes(keyword.toUpperCase()),
                );
            });
    }

    private extractVlessUris(source: string): string[] {
        return source
            .replace(/\r/g, '\n')
            .split(/(?=vless:\/\/)/g)
            .map((chunk) => chunk.trim())
            .filter((chunk) => chunk.startsWith('vless://'))
            .map((chunk) => chunk.replace(/[\u0000-\u001F]+$/g, ''));
    }

    private parseSingleUri(rawUri: string, sourcePosition: number): ParsedExternalVless {
        const url = new URL(rawUri);
        const params = url.searchParams;
        const decodedRemark = this.decodeRemark(url.hash.replace(/^#/, ''));
        const host = params.get('host') || '';
        const network = (params.get('type') || 'tcp').toLowerCase();
        const path = params.get('path') || '';
        const publicKey = params.get('pbk') || '';
        const sni = params.get('sni') || '';
        const shortId = params.get('sid') || '';
        const serviceName = params.get('serviceName') || '';
        const authority = params.get('authority') || '';
        const credential = decodeURIComponent(url.username);

        return {
            address: url.hostname,
            alpn: params.get('alpn') || '',
            authority: authority || null,
            credential,
            dedupeKey: this.createDedupeKey({
                address: url.hostname,
                credential,
                host,
                network,
                path,
                port: Number(url.port || 443),
                publicKey,
                security: (params.get('security') || 'none').toLowerCase(),
                serviceName,
                shortId,
                sni,
            }),
            displayCountry: this.parseDisplayCountry(decodedRemark),
            encryption: params.get('encryption') || 'none',
            fingerprint: params.get('fp') || params.get('fingerprint') || '',
            flow: params.get('flow') === 'xtls-rprx-vision' ? 'xtls-rprx-vision' : '',
            host,
            network,
            originalRemark: decodedRemark,
            path,
            port: Number(url.port || 443),
            publicKey,
            rawUri,
            remarkTags: this.extractRemarkTags(decodedRemark),
            security: (params.get('security') || 'none').toLowerCase(),
            serviceName,
            shortId,
            sni,
            sourcePosition,
            spiderX: params.get('spx') || params.get('spiderX') || '',
        };
    }

    private async getNodeHealth(
        address: string,
        port: null | number,
    ): Promise<{
        countryCode: null | string;
        countryName: null | string;
        isAlive: boolean;
        latencyMs: null | number;
        resolvedAddress: null | string;
    }> {
        const resolvedAddress = await this.resolveAddress(address);
        const geoData = resolvedAddress ? geoip.lookup(resolvedAddress) : null;
        const latencyMs = port ? await this.probeLatency(address, port) : null;

        return {
            countryCode: geoData?.country || null,
            countryName: geoData?.country ? this.resolveCountryName(geoData.country) : null,
            isAlive: latencyMs !== null,
            latencyMs,
            resolvedAddress,
        };
    }

    private async resolveAddress(address: string): Promise<null | string> {
        try {
            if (isIP(address)) {
                return address;
            }

            const resolved = await lookup(address);
            return resolved.address;
        } catch {
            return null;
        }
    }

    private resolveCountryName(countryCode: string): string {
        return new Intl.DisplayNames(['en'], { type: 'region' }).of(countryCode) || countryCode;
    }

    private parseDisplayCountry(remark: string): null | string {
        const sanitizedRemark = remark
            .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, '')
            .replace(/\|.*$/, '')
            .trim();

        if (!sanitizedRemark) {
            return null;
        }

        return sanitizedRemark.split(',')[0]?.trim() || null;
    }

    private createDedupeKey(input: Record<string, number | string>): string {
        const hash = createHash('sha256');
        hash.update(JSON.stringify(input));
        return hash.digest('hex');
    }

    private decodeRemark(input: string): string {
        try {
            return decodeURIComponent(input).replace(/\s+/g, ' ').trim();
        } catch {
            return input.trim();
        }
    }

    private extractRemarkTags(remark: string): string[] {
        const tags = new Set<string>();

        for (const match of remark.matchAll(/\[([^\]]+)\]/g)) {
            tags.add(match[1].trim().toUpperCase());
        }

        for (const word of remark.match(/\b(VK|YA|YANDEX|CDNVIDEO|BEELINE|BL)\b/gi) || []) {
            tags.add(word.toUpperCase());
        }

        return [...tags];
    }

    private async probeLatency(address: string, port: number): Promise<null | number> {
        return new Promise((resolve) => {
            const socket = new Socket();
            const startedAt = Date.now();
            let settled = false;

            const finish = (value: null | number) => {
                if (settled) {
                    return;
                }

                settled = true;
                socket.destroy();
                resolve(value);
            };

            socket.setTimeout(6000);
            socket.once('connect', () => finish(Date.now() - startedAt));
            socket.once('timeout', () => finish(null));
            socket.once('error', (error) => {
                this.logger.debug(`Probe failed for ${address}:${port} - ${String(error)}`);
                finish(null);
            });
            socket.connect(port, address);
        });
    }
}
