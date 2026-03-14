import { lookup } from 'node:dns/promises';
import { createHash } from 'node:crypto';
import { isIP, Socket } from 'node:net';

import axios from 'axios';
import geoip from 'geoip-lite';
import pMap from 'p-map';

import { TransactionalAdapterPrisma } from '@nestjs-cls/transactional-adapter-prisma';
import { TransactionHost } from '@nestjs-cls/transactional';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

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
    displayCountry: null | string;
    address: string;
    encryption: null | string;
    fingerprint: null | string;
    flow: null | string;
    host: null | string;
    isAlive: boolean;
    isPinned: boolean;
    latencyMs: null | number;
    network: string;
    originalRemark: string;
    path: null | string;
    port: number;
    priority: number;
    publicKey: null | string;
    resolvedAddress: null | string;
    security: string;
    serviceName: null | string;
    shortId: null | string;
    sni: null | string;
    spiderX: null | string;
    uuid: string;
};

const WHITE_SOURCE_URLS = [
    'https://raw.githubusercontent.com/igareck/vpn-configs-for-russia/refs/heads/main/Vless-Reality-White-Lists-Rus-Mobile.txt',
    'https://raw.githubusercontent.com/igareck/vpn-configs-for-russia/refs/heads/main/Vless-Reality-White-Lists-Rus-Mobile-2.txt',
    'https://raw.githubusercontent.com/igareck/vpn-configs-for-russia/refs/heads/main/WHITE-CIDR-RU-checked.txt',
];

const DEFAULT_PRESETS: ExternalPresetSeed[] = [
    {
        slug: 'auto-black',
        name: 'Auto server BLACK',
        sourceUrls: [
            'https://raw.githubusercontent.com/igareck/vpn-configs-for-russia/refs/heads/main/BLACK_VLESS_RUS_mobile.txt',
        ],
        includeKeywords: ['BL'],
        requiredSecurity: null,
        selectionLimit: 15,
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

        return this.prisma.tx.externalVlessPreset.findMany({
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
        return source
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line.startsWith('vless://'))
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

            socket.setTimeout(3000);
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
