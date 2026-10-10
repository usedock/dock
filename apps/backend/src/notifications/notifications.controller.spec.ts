import { NotificationsController } from './notifications.controller';
import { vi, type Mock } from 'vitest';

describe('NotificationsController', () => {
  let notifications: {
    listInbox: Mock;
    markRead: Mock;
    markAllRead: Mock;
    getPreferences: Mock;
    updateOrgPreference: Mock;
    updatePersonalPreference: Mock;
  };
  let controller: NotificationsController;
  const user = { id: 'u1', email: 'a@b.co', emailVerified: true, isInteractive: true };

  beforeEach(() => {
    notifications = {
      listInbox: vi.fn(),
      markRead: vi.fn(),
      markAllRead: vi.fn(),
      getPreferences: vi.fn(),
      updateOrgPreference: vi.fn(),
      updatePersonalPreference: vi.fn(),
    };
    controller = new NotificationsController(notifications as never);
  });

  it('lists the caller inbox with cursor and limit', async () => {
    notifications.listInbox.mockResolvedValue({ notifications: [], nextCursor: null });
    await expect(controller.listInbox(user, { cursor: 'c', limit: 10 })).resolves.toEqual({
      notifications: [],
      nextCursor: null,
    });
    expect(notifications.listInbox).toHaveBeenCalledWith('u1', 'c', 10);
  });

  it('marks a row read for the caller only', async () => {
    notifications.markRead.mockResolvedValue({ id: 'n1', read: true });
    await expect(controller.markRead(user, 'n1')).resolves.toEqual({ id: 'n1', read: true });
    expect(notifications.markRead).toHaveBeenCalledWith('u1', 'n1');
  });

  it('marks the whole caller inbox read', async () => {
    notifications.markAllRead.mockResolvedValue({ updated: 3 });
    await expect(controller.markAllRead(user)).resolves.toEqual({ updated: 3 });
    expect(notifications.markAllRead).toHaveBeenCalledWith('u1');
  });

  it('reads and writes preferences scoped to caller and org', async () => {
    notifications.getPreferences.mockResolvedValue({ organizationId: 'o1', preferences: [] });
    notifications.updateOrgPreference.mockResolvedValue({ organizationId: 'o1', type: 'disk_warning', enabled: false });
    notifications.updatePersonalPreference.mockResolvedValue({ type: 'disk_warning', emailEnabled: false });
    await controller.getPreferences(user, { organizationId: 'o1' });
    await controller.updateOrgPreference(user, { organizationId: 'o1', type: 'disk_warning', enabled: false });
    await controller.updatePersonalPreference(user, { type: 'disk_warning', emailEnabled: false });
    expect(notifications.getPreferences).toHaveBeenCalledWith('u1', 'o1');
    expect(notifications.updateOrgPreference).toHaveBeenCalledWith(user, 'o1', 'disk_warning', false);
    expect(notifications.updatePersonalPreference).toHaveBeenCalledWith('u1', 'disk_warning', false);
  });
});
