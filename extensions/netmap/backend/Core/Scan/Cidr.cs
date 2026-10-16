using System.Net;
using System.Net.Sockets;

namespace Duplo.Extension.NetMap.Core.Scan;

/// <summary>IPv4 CIDR range math for the overlap finding. IPv6 never overlaps IPv4 and is ignored in v1.</summary>
public static class Cidr
{
    public static bool TryParseV4(string cidr, out uint start, out uint end)
    {
        start = end = 0;
        var parts = cidr.Split('/');
        if (parts.Length != 2 || !int.TryParse(parts[1], out var bits) || bits is < 0 or > 32) return false;
        if (!IPAddress.TryParse(parts[0], out var ip) || ip.AddressFamily != AddressFamily.InterNetwork) return false;
        var b = ip.GetAddressBytes();
        var value = ((uint)b[0] << 24) | ((uint)b[1] << 16) | ((uint)b[2] << 8) | b[3];
        var mask = bits == 0 ? 0u : uint.MaxValue << (32 - bits);
        start = value & mask;
        end = start | ~mask;
        return true;
    }

    public static bool Overlaps(string a, string b) =>
        TryParseV4(a, out var s1, out var e1) && TryParseV4(b, out var s2, out var e2) && s1 <= e2 && s2 <= e1;
}
