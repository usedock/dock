import { vi } from 'vitest';
import { SshConnectionRegistry } from './ssh-connection-registry';

describe('SshConnectionRegistry', () => {
  it('ends every open connection of the user and only theirs', () => {
    const registry = new SshConnectionRegistry();
    const a = vi.fn();
    const b = vi.fn();
    const other = vi.fn();
    registry.register('u1', a);
    registry.register('u1', b);
    registry.register('u2', other);
    expect(registry.disconnectUser('u1')).toBe(2);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
  });

  it('forgets connections that closed on their own', () => {
    const registry = new SshConnectionRegistry();
    const a = vi.fn();
    registry.register('u1', a)();
    expect(registry.disconnectUser('u1')).toBe(0);
    expect(a).not.toHaveBeenCalled();
  });
});
