using Duplo.Extension.Cloudflare.Cf;
using FluentAssertions;
using Xunit;

namespace Duplo.Extension.Cloudflare.Tests;

public class CredentialsTests
{
    private static Dictionary<string, string> Data(params (string K, string V)[] kv) =>
        kv.ToDictionary(x => x.K, x => x.V);

    [Fact]
    public void Reads_keys_ignoring_case_and_separators()
    {
        var (conn, err) = CloudflareCredentials.From(Data(("ACCOUNT_ID", " acct "), ("api-token", "tok")), null);
        err.Should().BeNull();
        conn!.AccountId.Should().Be("acct");
        conn.ApiToken.Should().Be("tok");
        conn.BaseUrl.Should().Be(CloudflareCredentials.DefaultBaseUrl);
    }

    [Fact]
    public void Uses_provider_account_id_as_base_url_when_it_is_a_url()
    {
        var (conn, _) = CloudflareCredentials.From(Data(("accountId", "a"), ("apiToken", "t")), "https://api.cloudflare.com/client/v4/");
        conn!.BaseUrl.Should().Be("https://api.cloudflare.com/client/v4");

        var (conn2, _) = CloudflareCredentials.From(Data(("accountId", "a"), ("apiToken", "t")), "not-a-url");
        conn2!.BaseUrl.Should().Be(CloudflareCredentials.DefaultBaseUrl);
    }

    [Theory]
    [InlineData("apiToken", "accountId")]
    [InlineData("accountId", "apiToken")]
    public void Missing_key_is_named_in_the_error_and_no_value_leaks(string present, string missing)
    {
        var (conn, err) = CloudflareCredentials.From(Data((present, "s3cr3t")), null, "cloudflare-test");
        conn.Should().BeNull();
        err.Should().Contain(missing).And.Contain("cloudflare-test").And.NotContain("s3cr3t");
    }

    [Fact]
    public void Blank_values_count_as_missing()
    {
        var (_, err) = CloudflareCredentials.From(Data(("accountId", "a"), ("apiToken", "  ")), null);
        err.Should().Contain("apiToken");
    }
}

public class RateLimitTests
{
    private static readonly DateTime Now = new(2026, 10, 14, 12, 0, 0, DateTimeKind.Utc);

    [Theory]
    [InlineData(null, 10)]
    [InlineData("", 10)]
    [InlineData("garbage", 10)]
    [InlineData("5", 5)]
    [InlineData("0", 1)]
    [InlineData("600", 30)]
    public void Delay_from_seconds_is_clamped(string? header, int expectedSeconds) =>
        RateLimit.DelayFor(header, Now).Should().Be(TimeSpan.FromSeconds(expectedSeconds));

    [Fact]
    public void Delay_from_http_date()
    {
        var header = Now.AddSeconds(12).ToString("R");
        RateLimit.DelayFor(header, Now).Should().Be(TimeSpan.FromSeconds(12));
    }
}

public class TokenVerifyTests
{
    private static readonly DateTime Now = new(2026, 10, 14, 12, 0, 0, DateTimeKind.Utc);

    [Fact]
    public void Active_token_without_ttl_is_usable() =>
        new CfTokenVerify { Status = "active" }.UnusableReason(Now).Should().BeNull();

    [Fact]
    public void Future_not_before_is_reported_even_though_status_is_active() =>
        new CfTokenVerify { Status = "active", NotBefore = new DateTime(2026, 11, 30, 0, 0, 0, DateTimeKind.Utc) }
            .UnusableReason(Now).Should().Contain("not valid until 2026-11-30");

    [Fact]
    public void Past_expiry_and_inactive_status_are_reported()
    {
        new CfTokenVerify { Status = "active", ExpiresOn = Now.AddMinutes(-1) }.UnusableReason(Now).Should().Contain("expired");
        new CfTokenVerify { Status = "disabled" }.UnusableReason(Now).Should().Contain("'disabled'");
    }
}
