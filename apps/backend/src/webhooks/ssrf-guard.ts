import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export type HostResolver = (hostname: string) => Promise<string[]>;

/** Real resolver; specs inject a fake so no DNS leaves the process. */
export const defaultResolveHost: HostResolver = async (hostname) =>
  (await dnsLookup(hostname, { all: true })).map((a) => a.address);

/** [network, prefix length] pairs for IPv4 ranges a webhook must never reach. */
const DENIED_V4: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4], // reserved plus broadcast 255.255.255.255
];

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => acc * 256 + Number(part), 0);
}

function isDeniedV4(ip: string): boolean {
  const n = v4ToInt(ip);
  return DENIED_V4.some(([net, bits]) => {
    const size = 2 ** (32 - bits);
    return Math.floor(n / size) === Math.floor(v4ToInt(net) / size);
  });
}

/** Expands an IPv6 literal into 16 bytes, or null when malformed. */
function parseV6(ip: string): number[] | null {
  let text = ip;
  const tail = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    if (isIP(tail[1]) !== 4) return null;
    const o = tail[1].split('.').map(Number);
    text = text.slice(0, -tail[1].length) + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16);
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    const v = parseInt(g, 16);
    bytes.push(v >> 8, v & 0xff);
  }
  return bytes.length === 16 ? bytes : null;
}

const quad = (b: number[], at: number): string => `${b[at]}.${b[at + 1]}.${b[at + 2]}.${b[at + 3]}`;

/** True for any address outbound webhooks must not reach; unparseable input fails closed. */
export function isDeniedAddress(address: string): boolean {
  const ip = address.trim().replace(/^\[|\]$/g, '');
  const kind = isIP(ip);
  if (kind === 4) return isDeniedV4(ip);
  if (kind !== 6) return true;
  const b = parseV6(ip);
  if (!b) return true;
  if (b.slice(0, 10).every((x) => x === 0) && ((b[10] === 0 && b[11] === 0) || (b[10] === 0xff && b[11] === 0xff))) {
    return isDeniedV4(quad(b, 12)); // ::a.b.c.d, ::ffff:a.b.c.d, plus :: and ::1
  }
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    if (b.slice(4, 12).every((x) => x === 0)) return isDeniedV4(quad(b, 12)); // NAT64 64:ff9b::/96
    if (b[4] === 0 && b[5] === 1) return true; // 64:ff9b:1::/48 local-use NAT64
  }
  if (b.slice(0, 8).every((x) => x === 0) && b[8] === 0xff && b[9] === 0xff && b[10] === 0 && b[11] === 0) return true; // IPv4-translated ::ffff:0:0:0/96
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0 && b[3] === 0) return true; // Teredo 2001::/32
  if (b[0] === 0x20 && b[1] === 0x02) return isDeniedV4(quad(b, 2)); // 6to4 embeds an IPv4
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true; // docs 2001:db8::/32
  if ((b[0] & 0xfe) === 0xfc) return true; // unique local fc00::/7
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // link-local fe80::/10
  if (b[0] === 0xff) return true; // multicast
  return false;
}

/** Thrown when a host resolves to nothing public; the message is safe to surface. */
export class DeniedAddressError extends Error {
  constructor() {
    super('Url must not target a private or local network address');
  }
}

/** Resolves and vets a hostname at dial time, returning only the first allowed address. */
export async function resolveVetted(hostname: string, resolve: HostResolver = defaultResolveHost): Promise<string> {
  if (isIP(hostname)) {
    if (isDeniedAddress(hostname)) throw new DeniedAddressError();
    return hostname;
  }
  const addresses = await resolve(hostname);
  if (addresses.length === 0 || addresses.some(isDeniedAddress)) throw new DeniedAddressError();
  return addresses[0];
}

type LookupCallback = (err: Error | null, address: string | Array<{ address: string; family: number }>, family?: number) => void;

/** `lookup` option for node:https/net: the socket connects only to the address vetted here. */
export function pinnedLookup(resolve: HostResolver = defaultResolveHost) {
  return (hostname: string, options: { all?: boolean } | number | undefined, cb: LookupCallback): void => {
    const all = typeof options === 'object' && options !== null && options.all === true;
    resolveVetted(hostname, resolve).then(
      (address) => {
        const family = isIP(address);
        if (all) cb(null, [{ address, family }]);
        else cb(null, address, family);
      },
      (err: Error) => cb(err, '', 0),
    );
  };
}
