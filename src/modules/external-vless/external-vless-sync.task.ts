import { Cron, CronExpression } from '@nestjs/schedule';
import { Injectable, Logger } from '@nestjs/common';

import { ExternalVlessService } from './external-vless.service';

@Injectable()
export class ExternalVlessSyncTask {
    private readonly logger = new Logger(ExternalVlessSyncTask.name);

    constructor(private readonly externalVlessService: ExternalVlessService) {}

    @Cron(CronExpression.EVERY_HOUR, {
        name: 'external-vless-sync-hourly',
    })
    public async syncExternalVlessPresets(): Promise<void> {
        try {
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
            await this.externalVlessService.reprobeAllNodes();
        } catch (error) {
            this.logger.error(error);
        }
    }
}
