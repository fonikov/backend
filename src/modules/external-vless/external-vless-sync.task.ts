import { isScheduler } from '@common/utils/startup-app';

import { Cron, CronExpression } from '@nestjs/schedule';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';

import { ExternalVlessService } from './external-vless.service';

@Injectable()
export class ExternalVlessSyncTask implements OnApplicationBootstrap {
    private readonly logger = new Logger(ExternalVlessSyncTask.name);

    constructor(private readonly externalVlessService: ExternalVlessService) {}

    public async onApplicationBootstrap(): Promise<void> {
        if (!isScheduler()) {
            return;
        }

        // Do not block scheduler bootstrap and metrics health endpoint on long-running initial sync.
        setTimeout(() => {
            void this.runInitialSync();
        }, 0);
    }

    @Cron(CronExpression.EVERY_HOUR, {
        name: 'external-vless-sync-hourly',
    })
    public async syncExternalVlessPresets(): Promise<void> {
        try {
            this.logger.log('Running hourly external VLESS sync.');
            await this.externalVlessService.syncAllPresets();
        } catch (error) {
            this.logger.error(error);
        }
    }

    @Cron(CronExpression.EVERY_10_MINUTES, {
        name: 'external-vless-reprobe',
    })
    public async reprobeExternalVlessNodes(): Promise<void> {
        try {
            this.logger.log('Running external VLESS reprobe.');
            await this.externalVlessService.reprobeAllNodes();
        } catch (error) {
            this.logger.error(error);
        }
    }

    private async runInitialSync(): Promise<void> {
        try {
            this.logger.log('Running initial external VLESS sync on scheduler startup.');
            await this.externalVlessService.syncAllPresets();
        } catch (error) {
            this.logger.error(error);
        }
    }
}
