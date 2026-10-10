import { describe, expect, it } from 'vitest';
import { DeniedAddressError, isDeniedAddress, pinnedLookup, resolveVetted } from './ssrf-guard';

describe('isDeniedAddress', () => {
  it.each([
    '0.0.0.1', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255',
    '192.0.0.8', '192.168.1.1', '198.18.0.1', '198.19.255.255', '224.0.0.1', '239.255.255.250',
    '240.0.0.1', '255.255.255.255', '::', '::1', '::7f00:1', '::10.0.0.1', '::ffff:10.0.0.1',
    '::ffff:127.0.0.1', '::ffff:a00:1', '64:ff9b::a00:1', '64:ff9b::169.254.169.254', '64:ff9b:1::1',
    '64:ff9b:1:abcd::1', '2001:db8::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1', 'ff02::1',
    '2002:7f00:1::1', '::ffff:0:8.8.8.8', '2001:0:4136:e378::1', '[::1]', 'not-an-ip',
  ])('denies %s', (ip) => expect(isDeniedAddress(ip)).toBe(true));

  it.each(['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '198.20.0.1', '223.255.255.255', '2606:4700::1111', '::ffff:8.8.8.8', '64:ff9b::808:808', '2001:4860:4860::8888'])(
    'allows %s',
    (ip) => expect(isDeniedAddress(ip)).toBe(false),
  );
});

describe('dial-time pinning', () => {
  it('rejects a host that rebinds to a private address after registration', async () => {
    let calls = 0;
    const resolve = async () => (++calls === 1 ? ['93.184.216.34'] : ['10.0.0.5']);
    expect(await resolveVetted('hook.example.com', resolve)).toBe('93.184.216.34');
    await expect(resolveVetted('hook.example.com', resolve)).rejects.toBeInstanceOf(DeniedAddressError);
  });

  it('rejects when any resolved address is denied', async () => {
    await expect(resolveVetted('x.example.com', async () => ['8.8.8.8', '127.0.0.1'])).rejects.toBeInstanceOf(DeniedAddressError);
  });

  it('vets literal IPs', async () => {
    await expect(resolveVetted('169.254.169.254')).rejects.toBeInstanceOf(DeniedAddressError);
    expect(await resolveVetted('8.8.8.8')).toBe('8.8.8.8');
  });

  it('lookup errors on denied addresses and returns only the vetted one otherwise', async () => {
    const lookup = pinnedLookup(async () => ['10.0.0.5']);
    const denied = await new Promise<Error | null>((res) => lookup('a.example.com', {}, (err) => res(err)));
    expect(denied).toBeInstanceOf(DeniedAddressError);
    const ok = pinnedLookup(async () => ['93.184.216.34']);
    const all = await new Promise<unknown>((res) => ok('a.example.com', { all: true }, (_e, a) => res(a)));
    expect(all).toEqual([{ address: '93.184.216.34', family: 4 }]);
    const one = await new Promise<unknown>((res) => ok('a.example.com', {}, (_e, a) => res(a)));
    expect(one).toBe('93.184.216.34');
  });
});
