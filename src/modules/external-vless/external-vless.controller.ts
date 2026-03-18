import {
    ApiBearerAuth,
    ApiBody,
    ApiOkResponse,
    ApiParam,
    ApiTags,
} from '@nestjs/swagger';
import {
    Body,
    Controller,
    Get,
    HttpCode,
    Param,
    Patch,
    Post,
    UseFilters,
    UseGuards,
} from '@nestjs/common';

import { HttpExceptionFilter } from '@common/exception/http-exception.filter';
import { JwtDefaultGuard } from '@common/guards/jwt-guards/def-jwt-guard';
import { RolesGuard } from '@common/guards/roles/roles.guard';
import { Roles } from '@common/decorators/roles/roles';
import { ROLE } from '@libs/contracts/constants';

import { ExternalVlessService } from './external-vless.service';

class UpdateExternalVlessPresetDto {
    name?: string;
    isEnabled?: boolean;
    selectionLimit?: number;
}

class UpdateExternalVlessNodeDto {
    aliasRemark?: null | string;
    customTags?: string[];
    isEnabled?: boolean;
    isPinned?: boolean;
    priority?: number;
}

class CreateManualExternalVlessNodeDto {
    rawUri!: string;
    aliasRemark?: string;
    customTags?: string[];
    priority?: number;
}

@ApiBearerAuth('Authorization')
@ApiTags('External VLESS')
@Roles(ROLE.ADMIN, ROLE.API)
@UseGuards(JwtDefaultGuard, RolesGuard)
@UseFilters(HttpExceptionFilter)
@Controller('external-vless')
export class ExternalVlessController {
    constructor(private readonly externalVlessService: ExternalVlessService) {}

    @Get('presets')
    @ApiOkResponse({ description: 'External VLESS presets fetched successfully' })
    public async getPresets() {
        return {
            response: await this.externalVlessService.getPresetsWithNodes(),
        };
    }

    @Post('actions/sync')
    @HttpCode(200)
    @ApiOkResponse({ description: 'External VLESS presets synced successfully' })
    public async syncAllPresets() {
        return {
            response: await this.externalVlessService.syncAllPresets(),
        };
    }

    @Patch('presets/:uuid')
    @ApiParam({ name: 'uuid', type: String, required: true })
    @ApiBody({ type: UpdateExternalVlessPresetDto })
    public async updatePreset(
        @Param('uuid') uuid: string,
        @Body() body: UpdateExternalVlessPresetDto,
    ) {
        return {
            response: await this.externalVlessService.updatePreset(uuid, body),
        };
    }

    @Post('presets/:uuid/manual-nodes')
    @ApiParam({ name: 'uuid', type: String, required: true })
    @ApiBody({ type: CreateManualExternalVlessNodeDto })
    public async createManualNode(
        @Param('uuid') uuid: string,
        @Body() body: CreateManualExternalVlessNodeDto,
    ) {
        return {
            response: await this.externalVlessService.createManualNode(uuid, body),
        };
    }

    @Patch('nodes/:uuid')
    @ApiParam({ name: 'uuid', type: String, required: true })
    @ApiBody({ type: UpdateExternalVlessNodeDto })
    public async updateNode(
        @Param('uuid') uuid: string,
        @Body() body: UpdateExternalVlessNodeDto,
    ) {
        return {
            response: await this.externalVlessService.updateNode(uuid, body),
        };
    }
}
