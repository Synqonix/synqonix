import { isIP } from 'node:net';

/** Whether a dotted IPv4 address is loopback, private, link-local, CGNAT, reserved, multicast, ... */
function isPrivateV4([a, b, c]: number[]): boolean {
  return (
    a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

/** The 16 bytes of an IPv6 address, in any notation (`::` compression, dotted IPv4 tail, zone id). */
function ipv6Bytes(address: string): number[] | null {
  let text = address.split('%')[0].toLowerCase();
  const tail: number[] = [];
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    if (isIP(dotted[2]) !== 4) return null;
    const [a, b, c, d] = dotted[2].split('.').map(Number);
    tail.push((a << 8) | b, (c << 8) | d);
    // Drop the separator before the IPv4 part, but keep a `::` that compresses zeros.
    text = dotted[1].endsWith('::') ? dotted[1] : dotted[1].slice(0, -1);
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === '' ? [] : part.split(':').map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN)));
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  const given = head.length + rest.length + tail.length;
  if ([...head, ...rest].some(Number.isNaN) || given > 8 || (halves.length === 1 && given !== 8)) return null;
  const groups = [...head, ...Array.from({ length: 8 - given }, () => 0), ...rest, ...tail];
  return groups.flatMap((g) => [g >> 8, g & 0xff]);
}

/** Whether an IP address is somewhere a public webhook must never reach (loopback, private, link-local, metadata, ...). */
export function isPrivateAddress(address: string): boolean {
  const kind = isIP(address.split('%')[0]);
  if (kind === 4) return isPrivateV4(address.split('.').map(Number));
  if (kind !== 6) return true; // not an address at all: refuse
  const b = ipv6Bytes(address);
  if (!b) return true;
  const zeros = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  const v4 = (at: number) => b.slice(at, at + 4);

  if (zeros(0, 15) && b[15] <= 1) return true; // :: and ::1
  // IPv4 inside IPv6: mapped (::ffff:a.b.c.d), compatible (::a.b.c.d), NAT64 (64:ff9b::a.b.c.d) and 6to4 (2002:ab:cd::)
  if (zeros(0, 10) && b[10] === 0xff && b[11] === 0xff) return isPrivateV4(v4(12));
  if (zeros(0, 12)) return isPrivateV4(v4(12));
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zeros(4, 12)) return isPrivateV4(v4(12));
  if (b[0] === 0x20 && b[1] === 0x02) return isPrivateV4(v4(2));
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) return true; // local-use NAT64 (64:ff9b:1::/48)
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return true; // Teredo: hides an IPv4 address
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true; // documentation
  if (b[0] === 0x01 && b[1] === 0x00 && zeros(2, 8)) return true; // discard-only 100::/64
  return (b[0] & 0xfe) === 0xfc || (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) || b[0] === 0xff; // ULA, link-local, multicast
}

export interface UrlCheck { ok: boolean; reason?: string }

/** Cheap checks done when a webhook is saved. DNS is checked again when delivering. */
export function checkWebhookUrl(raw: string, allowPrivate: boolean): UrlCheck {
  let url: URL;
  try { url = new URL(raw); } catch { return { ok: false, reason: 'That is not a valid URL' }; }
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) return { ok: false, reason: 'Webhook URLs must use https' };
  if (url.username || url.password) return { ok: false, reason: 'Put credentials in a header or the signature, not the URL' };
  if (raw.length > 2000) return { ok: false, reason: 'The URL is too long' };
  if (allowPrivate) return { ok: true };
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.') && isIP(host) === 0) {
    return { ok: false, reason: 'That address is not reachable from the internet' };
  }
  if (isIP(host) !== 0 && isPrivateAddress(host)) return { ok: false, reason: 'That address is not reachable from the internet' };
  return { ok: true };
}
