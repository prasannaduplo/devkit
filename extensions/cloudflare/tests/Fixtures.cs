using System.Net;
using System.Text;
using System.Text.Json;
using Duplo.Extension.Cloudflare.Cf;

namespace Duplo.Extension.Cloudflare.Tests;

internal static class Fixtures
{
    private static readonly JsonSerializerOptions Json = new() { PropertyNameCaseInsensitive = true };

    public static string Read(string name) =>
        File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", name));

    public static T Result<T>(string name) =>
        JsonSerializer.Deserialize<CfEnvelope<T>>(Read(name), Json)!.Result!;

    public static CfScript Script(string id, string modified, string? created = null) => new()
    {
        Id = id,
        ModifiedOn = DateTime.Parse(modified).ToUniversalTime(),
        CreatedOn = created == null ? null : DateTime.Parse(created).ToUniversalTime(),
    };

    public static CfDeployment Deployment(string id, string created, string? author = "dev@example.com", params string[] versions) => new()
    {
        Id = id,
        CreatedOn = DateTime.Parse(created).ToUniversalTime(),
        AuthorEmail = author,
        Source = "wrangler",
        Versions = versions.Select(v => new CfDeploymentVersion { VersionId = v, Percentage = 100 }).ToList(),
    };
}

/// <summary>Replays queued responses and records the requests it saw.</summary>
internal sealed class FakeHandler : HttpMessageHandler
{
    private readonly Queue<HttpResponseMessage> _responses = new();
    public List<HttpRequestMessage> Requests { get; } = new();

    public FakeHandler Enqueue(HttpStatusCode status, string body, (string, string)? header = null)
    {
        var resp = new HttpResponseMessage(status) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        if (header is { } h) resp.Headers.TryAddWithoutValidation(h.Item1, h.Item2);
        _responses.Enqueue(resp);
        return this;
    }

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        Requests.Add(request);
        if (_responses.Count == 0) throw new InvalidOperationException($"Unexpected request {request.RequestUri}");
        return Task.FromResult(_responses.Dequeue());
    }
}
