import { ALLOW_DOCK_KEY } from '../common/allow-dock-key.decorator';
import { InvitationsController } from './invitations.controller';
import { OrganizationsController } from './organizations.controller';

describe('invitation routes and dock-bound keys', () => {
  it('no invitation or member route opts in to dock-bound keys', () => {
    for (const controller of [InvitationsController, OrganizationsController]) {
      expect(Reflect.getMetadata(ALLOW_DOCK_KEY, controller)).toBeUndefined();
      for (const name of Object.getOwnPropertyNames(controller.prototype)) {
        if (name === 'constructor') continue;
        expect(Reflect.getMetadata(ALLOW_DOCK_KEY, controller.prototype[name as keyof typeof controller.prototype])).toBeUndefined();
      }
    }
  });
});
