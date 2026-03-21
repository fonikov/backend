import { createZodDto } from 'nestjs-zod';

import { ImportHostsFromVlessSubscriptionCommand } from '@libs/contracts/commands';

export class ImportHostsFromVlessSubscriptionRequestDto extends createZodDto(
    ImportHostsFromVlessSubscriptionCommand.RequestSchema,
) {}

export class ImportHostsFromVlessSubscriptionResponseDto extends createZodDto(
    ImportHostsFromVlessSubscriptionCommand.ResponseSchema,
) {}
