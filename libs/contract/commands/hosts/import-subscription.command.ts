import { z } from 'zod';

import { getEndpointDetails } from '../../constants';
import { HOSTS_ROUTES, REST_API } from '../../api';

const HostTagSchema = z
    .string()
    .regex(
        /^[A-Z0-9_:]+$/,
        'Tag can only contain uppercase letters, numbers, underscores and colons',
    )
    .max(32, 'Tag must be less than 32 characters')
    .nullable()
    .optional();

export namespace ImportHostsFromVlessSubscriptionCommand {
    export const url = REST_API.HOSTS.ACTIONS.IMPORT_SUBSCRIPTION;
    export const TSQ_url = url;

    export const endpointDetails = getEndpointDetails(
        HOSTS_ROUTES.ACTIONS.IMPORT_SUBSCRIPTION,
        'post',
        'Import regular hosts from a VLESS subscription payload or URL',
    );

    export const RequestSchema = z.object({
        inbound: z.object({
            configProfileUuid: z.string().uuid(),
            configProfileInboundUuid: z.string().uuid(),
        }),
        input: z.string().min(1, 'Input is required'),
        isDisabled: z.boolean().optional().default(false),
        isHidden: z.boolean().optional().default(false),
        tag: HostTagSchema,
    });

    export type Request = z.infer<typeof RequestSchema>;

    export const ResponseSchema = z.object({
        response: z.object({
            createdCount: z.number().int().nonnegative(),
            parsedCount: z.number().int().nonnegative(),
            skippedCount: z.number().int().nonnegative(),
        }),
    });

    export type Response = z.infer<typeof ResponseSchema>;
}
