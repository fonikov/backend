import { createZodDto } from 'nestjs-zod';

import { ImportHostCommand } from '@libs/contracts/commands';

export class ImportHostRequestDto extends createZodDto(ImportHostCommand.RequestSchema) {}
export class ImportHostResponseDto extends createZodDto(ImportHostCommand.ResponseSchema) {}
