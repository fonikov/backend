import { z } from 'zod';

import {
    getEndpointDetails,
    FINGERPRINTS,
    SECURITY_LAYERS,
    ALPN,
} from '../../constants';
import { HOSTS_ROUTES, REST_API } from '../../api';

export namespace ImportHostCommand {
    export const url = REST_API.HOSTS.ACTIONS.IMPORT;
    export const TSQ_url = url;

    export const endpointDetails = getEndpointDetails(
        HOSTS_ROUTES.ACTIONS.IMPORT,
        'post',
        'Parse a VLESS URI or Xray JSON into host form fields',
    );

    export const RequestSchema = z.object({
        format: z.enum(['VLESS_URI', 'XRAY_JSON']),
        input: z.string().min(1),
    });

    export type Request = z.infer<typeof RequestSchema>;

    export const ResponseSchema = z.object({
        response: z.object({
            remark: z.string().nullable(),
            address: z.string(),
            port: z.number().int(),
            path: z.string().nullable(),
            sni: z.string().nullable(),
            host: z.string().nullable(),
            alpn: z.nativeEnum(ALPN).nullable(),
            fingerprint: z.nativeEnum(FINGERPRINTS).nullable(),
            allowInsecure: z.boolean(),
            securityLayer: z.nativeEnum(SECURITY_LAYERS),
        }),
    });

    export type Response = z.infer<typeof ResponseSchema>;
}
