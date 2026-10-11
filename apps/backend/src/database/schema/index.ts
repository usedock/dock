export * from './users';
export * from './profiles';
export * from './better-auth';
export * from './api-keys';
export * from './ssh-keys';
export * from './organizations';
export * from './organization-members';
export * from './organization-invitations';
export * from './workspaces';
export * from './docks';
export * from './dock-stats';
export * from './dock-ports';
export * from './snapshots';
export * from './templates';
export * from './operations';
export * from './idempotency-keys';
export * from './retention-policies';
export * from './account-closures';
export * from './billing';
export * from './environments';
export * from './hosts';
export * from './host-commands';
export * from './webhooks';
export * from './github';
export * from './agent-credentials';
export * from './chatgpt-connections';
export * from './connectors';
export * from './notifications';

import * as usersModule from './users';
import * as profilesModule from './profiles';
import * as betterAuthModule from './better-auth';
import * as apiKeysModule from './api-keys';
import * as sshKeysModule from './ssh-keys';
import * as organizationsModule from './organizations';
import * as organizationMembersModule from './organization-members';
import * as organizationInvitationsModule from './organization-invitations';
import * as workspacesModule from './workspaces';
import * as docksModule from './docks';
import * as dockStatsModule from './dock-stats';
import * as dockPortsModule from './dock-ports';
import * as snapshotsModule from './snapshots';
import * as templatesModule from './templates';
import * as operationsModule from './operations';
import * as idempotencyKeysModule from './idempotency-keys';
import * as retentionPoliciesModule from './retention-policies';
import * as accountClosuresModule from './account-closures';
import * as billingModule from './billing';
import * as environmentsModule from './environments';
import * as hostsModule from './hosts';
import * as hostCommandsModule from './host-commands';
import * as webhooksModule from './webhooks';
import * as githubModule from './github';
import * as agentCredentialsModule from './agent-credentials';
import * as chatgptConnectionsModule from './chatgpt-connections';
import * as connectorsModule from './connectors';
import * as notificationsModule from './notifications';

export const schema = {
  ...usersModule,
  ...profilesModule,
  ...betterAuthModule,
  ...apiKeysModule,
  ...sshKeysModule,
  ...organizationsModule,
   ...docksModule,
  ...dockStatsModule,
  ...dockPortsModule,
  ...snapshotsModule,
  ...templatesModule,
  ...operationsModule,
  ...idempotencyKeysModule,
  ...retentionPoliciesModule,
  ...accountClosuresModule,
  ...billingModule,
  ...organizationMembersModule,
  ...organizationInvitationsModule,
  ...environmentsModule,
  ...hostsModule,
  ...hostCommandsModule,
  ...webhooksModule,
  ...githubModule,
  ...agentCredentialsModule,
  ...chatgptConnectionsModule,
  ...connectorsModule,
  ...notificationsModule,
  ...workspacesModule,
};
