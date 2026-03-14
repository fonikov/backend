import { ExternalSquadEntity } from '@modules/external-squads/entities/external-squad.entity';
import { HostWithRawInbound } from '@modules/hosts/entities/host-with-inbound-tag.entity';
import { ISRRContext } from '@modules/subscription-response-rules/interfaces';
import { IFormattedHost } from '@modules/subscription-template/generators/interfaces';
import { UserEntity } from '@modules/users/entities/user.entity';

export interface IGenerateSubscription {
    srrContext: ISRRContext;
    user: UserEntity;
    hosts: HostWithRawInbound[];
    additionalFormattedHosts?: IFormattedHost[];
    hostsOverrides?: ExternalSquadEntity['hostOverrides'];
    fallbackOptions?: {
        showHwidMaxDeviceRemarks?: boolean;
        showHwidNotSupportedRemarks?: boolean;
    };
}
