/** IPv4 CIDR → inclusive [start, end] as unsigned numbers; null for anything else (IPv6 included). */
export function parseV4(cidr: string): [number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(cidr.trim());
  if (!m) return null;
  const octets = m.slice(1, 5).map(Number);
  const bits = Number(m[5]);
  if (octets.some(o => o > 255) || bits > 32) return null;
  const value = octets[0] * 16777216 + octets[1] * 65536 + octets[2] * 256 + octets[3];
  const size = 2 ** (32 - bits);
  const start = Math.floor(value / size) * size;
  return [start, start + size - 1];
}

export function cidrsOverlap(a: string, b: string): boolean {
  const x = parseV4(a);
  const y = parseV4(b);
  return !!x && !!y && x[0] <= y[1] && y[0] <= x[1];
}
