using System.Globalization;

namespace Duplo.Extension.Cloudflare.Cf;

/// <summary>
/// How long to wait after a 429, from the <c>Retry-After</c> header (delta-seconds or an HTTP-date). Clamped so a
/// single retry fits inside one worker tick (~97s budget); anything longer is left to the next tick.
/// Pure — the caller sleeps — modelled on prd-mgmt-extension's ClickUpRateLimit.
/// </summary>
public static class RateLimit
{
    public static readonly TimeSpan Default = TimeSpan.FromSeconds(10);
    public static readonly TimeSpan Max = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan Min = TimeSpan.FromSeconds(1);

    public static TimeSpan DelayFor(string? retryAfter, DateTime nowUtc)
    {
        if (string.IsNullOrWhiteSpace(retryAfter)) return Default;
        var v = retryAfter.Trim();
        if (int.TryParse(v, NumberStyles.Integer, CultureInfo.InvariantCulture, out var secs))
            return Clamp(TimeSpan.FromSeconds(secs));
        if (DateTimeOffset.TryParse(v, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var at))
            return Clamp(at.UtcDateTime - nowUtc);
        return Default;
    }

    private static TimeSpan Clamp(TimeSpan t) => t < Min ? Min : t > Max ? Max : t;
}
