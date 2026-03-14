import { CqrsModule } from '@nestjs/cqrs';
import { Module } from '@nestjs/common';

import { ExternalVlessController } from './external-vless.controller';
import { ExternalVlessSyncTask } from './external-vless-sync.task';
import { ExternalVlessService } from './external-vless.service';

@Module({
    imports: [CqrsModule],
    controllers: [ExternalVlessController],
    providers: [ExternalVlessService, ExternalVlessSyncTask],
    exports: [ExternalVlessService],
})
export class ExternalVlessModule {}
