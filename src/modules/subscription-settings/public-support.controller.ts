import type { Response } from 'express';

import { Controller, Get, HttpStatus, Logger, Res } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';

import { GetCachedSubscriptionSettingsQuery } from './queries/get-cached-subscrtipion-settings/get-cached-subscrtipion-settings.query';

@Controller('support')
export class PublicSupportController {
    private readonly logger = new Logger(PublicSupportController.name);

    constructor(private readonly queryBus: QueryBus) {}

    @Get()
    async redirectToSupport(@Res() response: Response): Promise<Response> {
        const settings = await this.queryBus.execute<GetCachedSubscriptionSettingsQuery, {
            supportLink?: string | null;
        } | null>(new GetCachedSubscriptionSettingsQuery());

        const supportLink = settings?.supportLink?.trim();

        if (!supportLink) {
            return response
                .status(HttpStatus.NOT_FOUND)
                .type('text/plain; charset=utf-8')
                .send('Support link is not configured');
        }

        try {
            const url = new URL(supportLink);

            if (!['http:', 'https:'].includes(url.protocol)) {
                throw new Error(`Unsupported protocol: ${url.protocol}`);
            }

            response.setHeader('Cache-Control', 'no-store');
            response.redirect(HttpStatus.FOUND, url.toString());
            return response;
        } catch (error) {
            this.logger.warn(`Invalid support link configured: ${supportLink} - ${String(error)}`);

            return response
                .status(HttpStatus.NOT_FOUND)
                .type('text/plain; charset=utf-8')
                .send('Support link is invalid');
        }
    }
}
