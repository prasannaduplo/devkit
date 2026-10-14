using System.Net;
using Duplo.Extension.Cloudflare.Cf;
using FluentAssertions;
using Xunit;

namespace Duplo.Extension.Cloudflare.Tests;

public class CloudflareClientTests
{
    private const string Token = "secret-token-value";
    private static readonly CloudflareConnection Conn = new(CloudflareCredentials.DefaultBaseUrl, "acct123", Token);

    private static (CloudflareClient Client, FakeHandler Handler, List<TimeSpan> Delays) Make()
    {
        var handler = new FakeHandler();
        var delays = new List<TimeSpan>();
        var client = new CloudflareClient(new HttpClient(handler), Conn,
            (t, _) => { delays.Add(t); return Task.CompletedTask; },
            () => new DateTime(2026, 10, 14, 12, 0, 0, DateTimeKind.Utc));
        return (client, handler, delays);
    }

    [Fact]
    public async Task Verify_sends_bearer_token_to_account_endpoint()
    {
        var (client, handler, _) = Make();
        handler.Enqueue(HttpStatusCode.OK, Fixtures.Read("verify-active.json"));

        var v = await client.VerifyTokenAsync(CancellationToken.None);

        v.Status.Should().Be("active");
        var req = handler.Requests.Single();
        req.RequestUri!.ToString().Should().Be("https://api.cloudflare.com/client/v4/accounts/acct123/tokens/verify");
        req.Headers.Authorization!.Scheme.Should().Be("Bearer");
        req.Headers.Authorization.Parameter.Should().Be(Token);
    }

    [Fact]
    public async Task Verify_falls_back_to_user_endpoint_for_user_tokens()
    {
        var (client, handler, _) = Make();
        handler.Enqueue(HttpStatusCode.Unauthorized, Fixtures.Read("error-auth.json"))
               .Enqueue(HttpStatusCode.OK, Fixtures.Read("verify-active.json"));

        (await client.VerifyTokenAsync(CancellationToken.None)).Status.Should().Be("active");
        handler.Requests.Select(r => r.RequestUri!.AbsolutePath).Should().Equal(
            "/client/v4/accounts/acct123/tokens/verify", "/client/v4/user/tokens/verify");
    }

    [Fact]
    public async Task Verify_reports_failure_when_both_endpoints_reject()
    {
        var (client, handler, _) = Make();
        handler.Enqueue(HttpStatusCode.Unauthorized, Fixtures.Read("error-auth.json"))
               .Enqueue(HttpStatusCode.Unauthorized, Fixtures.Read("error-auth.json"));

        var ex = (await ((Func<Task>)(() => client.VerifyTokenAsync(CancellationToken.None))).Should().ThrowAsync<CloudflareApiException>()).Which;
        ex.Message.Should().Contain("/user/tokens/verify").And.Contain("Authentication error");
    }

    [Fact]
    public async Task ListScripts_parses_and_follows_pagination()
    {
        var (client, handler, _) = Make();
        handler.Enqueue(HttpStatusCode.OK, Fixtures.Read("scripts-page1.json"))
               .Enqueue(HttpStatusCode.OK, Fixtures.Read("scripts-page2.json"));

        var scripts = await client.ListScriptsAsync(CancellationToken.None);

        scripts.Select(s => s.Id).Should().Equal("a", "b");
        handler.Requests.Select(r => r.RequestUri!.Query).Should().Equal("?page=1&per_page=100", "?page=2&per_page=100");
    }

    [Fact]
    public async Task ListScripts_single_page_without_result_info()
    {
        var (client, handler, _) = Make();
        handler.Enqueue(HttpStatusCode.OK, Fixtures.Read("scripts.json"));

        var scripts = await client.ListScriptsAsync(CancellationToken.None);
        scripts.Select(s => s.Id).Should().Equal("api-gateway", "agent-runner");
        handler.Requests.Should().ContainSingle();
    }

    [Fact]
    public async Task ListDeployments_escapes_script_name_and_reads_annotations()
    {
        var (client, handler, _) = Make();
        handler.Enqueue(HttpStatusCode.OK, Fixtures.Read("deployments-api-gateway.json"));

        var deps = await client.ListDeploymentsAsync("api gateway", CancellationToken.None);

        handler.Requests.Single().RequestUri!.AbsolutePath.Should().EndWith("/workers/scripts/api%20gateway/deployments");
        deps.Select(d => d.Id).Should().Equal("dep-3", "dep-2");
        deps[0].Annotation("workers/message").Should().Be("fix routing");
    }

    [Fact]
    public async Task Error_envelope_becomes_exception_without_the_token()
    {
        var (client, handler, _) = Make();
        handler.Enqueue(HttpStatusCode.Forbidden, Fixtures.Read("error-auth.json"));

        var act = () => client.ListScriptsAsync(CancellationToken.None);

        var ex = (await act.Should().ThrowAsync<CloudflareApiException>()).Which;
        ex.Status.Should().Be(HttpStatusCode.Forbidden);
        ex.Message.Should().Contain("10000: Authentication error").And.Contain("/accounts/acct123/workers/scripts");
        ex.Message.Should().NotContain(Token).And.NotContain("page=");
    }

    [Fact]
    public async Task Non_json_error_body_is_truncated_into_the_message()
    {
        var (client, handler, _) = Make();
        handler.Enqueue(HttpStatusCode.BadGateway, "<html>" + new string('x', 500) + "</html>");

        var ex = (await ((Func<Task>)(() => client.VerifyTokenAsync(CancellationToken.None))).Should().ThrowAsync<CloudflareApiException>()).Which;
        ex.Message.Should().Contain("502").And.EndWith("…");
    }

    [Fact]
    public async Task RateLimited_once_waits_retry_after_then_succeeds()
    {
        var (client, handler, delays) = Make();
        handler.Enqueue(HttpStatusCode.TooManyRequests, "{}", ("Retry-After", "7"))
               .Enqueue(HttpStatusCode.OK, Fixtures.Read("verify-active.json"));

        (await client.VerifyTokenAsync(CancellationToken.None)).Status.Should().Be("active");
        delays.Should().Equal(TimeSpan.FromSeconds(7));
        handler.Requests.Should().HaveCount(2);
    }

    [Fact]
    public async Task RateLimited_twice_gives_up_for_this_tick()
    {
        var (client, handler, delays) = Make();
        handler.Enqueue(HttpStatusCode.TooManyRequests, "{}", ("Retry-After", "5"))
               .Enqueue(HttpStatusCode.TooManyRequests, "{\"success\":false,\"errors\":[{\"code\":971,\"message\":\"Please wait\"}]}");

        var ex = (await ((Func<Task>)(() => client.VerifyTokenAsync(CancellationToken.None))).Should().ThrowAsync<CloudflareApiException>()).Which;
        ex.Status.Should().Be(HttpStatusCode.TooManyRequests);
        delays.Should().ContainSingle();
    }
}
