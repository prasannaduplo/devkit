using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using Duplo.Extension.NetMap.Core.K8s;
using FluentAssertions;
using Xunit;

namespace Duplo.Extension.NetMap.Tests;

public class EksProbeTests
{
    private const string Token = "k8s-aws-v1.test-token-not-real";
    private static readonly Uri Endpoint = new("https://ABC123.gr7.us-east-1.eks.amazonaws.com");

    private sealed class FakeHandler : HttpMessageHandler
    {
        private readonly Func<HttpRequestMessage, string, HttpResponseMessage> _respond;
        public List<string> Seen { get; } = new();
        public FakeHandler(Func<HttpRequestMessage, string, HttpResponseMessage> respond) => _respond = respond;

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage req, CancellationToken ct)
        {
            req.Headers.Authorization!.ToString().Should().Be("Bearer " + Token);
            var body = req.Content == null ? "" : await req.Content.ReadAsStringAsync(ct);
            Seen.Add($"{req.Method} {req.RequestUri!.AbsolutePath}");
            return _respond(req, body);
        }
    }

    private static HttpResponseMessage Json(HttpStatusCode code, string json) =>
        new(code) { Content = new StringContent(json, Encoding.UTF8, "application/json") };

    private static HttpResponseMessage Review(string body, params string[] allowed) =>
        Json(HttpStatusCode.Created, $"{{\"status\":{{\"allowed\":{(allowed.Any(body.Contains) ? "true" : "false")}}}}}");

    private static async Task<K8sProbeResult> Run(HttpMessageHandler handler, bool? publicAccess = true, string? authMode = "API_AND_CONFIG_MAP")
    {
        var r = new K8sProbeResult { Cluster = "c", Region = "us-east-1", EndpointPublicAccess = publicAccess, AuthenticationMode = authMode };
        using var ca = SelfSignedCa("probe-test-ca");
        await new EksProbe(handlerFactory: _ => handler).ProbeApiAsync(r, Endpoint, ca, Token, CancellationToken.None);
        return r;
    }

    [Fact]
    public async Task All_allowed_reports_ok_with_git_version()
    {
        var h = new FakeHandler((req, body) => req.RequestUri!.AbsolutePath == "/version"
            ? Json(HttpStatusCode.OK, "{\"gitVersion\":\"v1.30.4-eks-a737599\"}")
            : Review(body, "pods", "services", "networkpolicies"));

        var r = await Run(h);

        r.ApiReachable.Should().BeTrue();
        r.ApiVersion.Should().Be("v1.30.4-eks-a737599");
        (r.CanListPods, r.CanListServices, r.CanListNetworkPolicies).Should().Be((true, true, true));
        r.HttpStatus.Should().Be(201);
        r.Message.Should().StartWith("OK");
        h.Seen.Should().Equal("GET /version",
            "POST /apis/authorization.k8s.io/v1/selfsubjectaccessreviews",
            "POST /apis/authorization.k8s.io/v1/selfsubjectaccessreviews",
            "POST /apis/authorization.k8s.io/v1/selfsubjectaccessreviews");
    }

    [Fact]
    public async Task Review_bodies_ask_for_cluster_wide_list_in_the_right_groups()
    {
        var bodies = new List<string>();
        var h = new FakeHandler((req, body) =>
        {
            if (req.RequestUri!.AbsolutePath == "/version") return Json(HttpStatusCode.OK, "{\"gitVersion\":\"v1\"}");
            bodies.Add(body);
            return Review(body, "pods");
        });

        var r = await Run(h);

        bodies.Should().HaveCount(3);
        bodies[0].Should().Contain("\"kind\":\"SelfSubjectAccessReview\"").And.Contain("\"verb\":\"list\",\"group\":\"\",\"resource\":\"pods\"");
        bodies[2].Should().Contain("\"group\":\"networking.k8s.io\",\"resource\":\"networkpolicies\"");
        bodies.Should().OnlyContain(b => !b.Contains("namespace"));
        (r.CanListPods, r.CanListServices, r.CanListNetworkPolicies).Should().Be((true, false, false));
        r.Message.Should().Contain("RBAC denies").And.Contain("services, networkpolicies");
    }

    [Fact]
    public async Task Unauthorized_means_identity_not_mapped()
    {
        var r = await Run(new FakeHandler((_, _) => new HttpResponseMessage(HttpStatusCode.Unauthorized)), authMode: "CONFIG_MAP");

        r.ApiReachable.Should().BeTrue();
        r.HttpStatus.Should().Be(401);
        r.CanListPods.Should().BeNull();
        r.Message.Should().Contain("401").And.Contain("aws-auth");
    }

    [Fact]
    public async Task Unauthorized_on_review_after_public_version_is_still_not_mapped()
    {
        var r = await Run(new FakeHandler((req, _) => req.RequestUri!.AbsolutePath == "/version"
            ? Json(HttpStatusCode.OK, "{\"gitVersion\":\"v1\"}")
            : new HttpResponseMessage(HttpStatusCode.Unauthorized)), authMode: "API");

        r.HttpStatus.Should().Be(401);
        r.ApiVersion.Should().Be("v1");
        r.Message.Should().Contain("access entry");
    }

    [Fact]
    public async Task Forbidden_means_mapped_without_rbac()
    {
        var r = await Run(new FakeHandler((req, _) => req.RequestUri!.AbsolutePath == "/version"
            ? Json(HttpStatusCode.OK, "{\"gitVersion\":\"v1\"}")
            : new HttpResponseMessage(HttpStatusCode.Forbidden)));

        r.HttpStatus.Should().Be(403);
        r.Message.Should().Contain("403").And.Contain("AmazonEKSViewPolicy");
    }

    [Fact]
    public async Task Timeout_on_private_endpoint_explains_the_network_path()
    {
        var r = await Run(new FakeHandler((_, _) => throw new TaskCanceledException("t", new TimeoutException())), publicAccess: false);

        r.ApiReachable.Should().BeFalse();
        r.HttpStatus.Should().BeNull();
        r.Message.Should().Contain("Timed out").And.Contain("private-only");
    }

    [Fact]
    public async Task Tls_and_connection_failures_are_distinguished()
    {
        var tls = await Run(new FakeHandler((_, _) => throw new HttpRequestException("ssl", new AuthenticationException("bad cert"))));
        tls.Message.Should().StartWith("TLS handshake failed");

        var conn = await Run(new FakeHandler((_, _) => throw new HttpRequestException("conn", new SocketException((int)SocketError.ConnectionRefused))));
        conn.Message.Should().Contain("Could not connect").And.Contain("ConnectionRefused");
    }

    [Fact]
    public async Task Messages_never_contain_the_token()
    {
        foreach (var respond in new Func<HttpRequestMessage, string, HttpResponseMessage>[]
                 {
                     (_, _) => new HttpResponseMessage(HttpStatusCode.Unauthorized),
                     (_, _) => new HttpResponseMessage(HttpStatusCode.InternalServerError),
                     (_, _) => throw new HttpRequestException("boom"),
                 })
            (await Run(new FakeHandler(respond))).Message.Should().NotContain("k8s-aws-v1");
    }

    [Theory]
    [InlineData("arn:aws:sts::111111111111:assumed-role/duplo-helpdesk/session-123@x", "arn:aws:sts::111111111111:assumed-role/duplo-helpdesk/…")]
    [InlineData("arn:aws-cn:sts::111111111111:assumed-role/r/s", "arn:aws-cn:sts::111111111111:assumed-role/r/…")]
    [InlineData("arn:aws:iam::111111111111:user/alice", "arn:aws:iam::111111111111:user/alice")]
    public void Caller_arn_session_name_is_redacted(string arn, string expected) =>
        EksProbe.RedactCallerArn(arn).Should().Be(expected);

    [Fact]
    public void Cluster_ca_is_the_only_trust_root()
    {
        using var ca = SelfSignedCa("cluster-ca");
        using var other = SelfSignedCa("other-ca");
        using var leaf = IssueLeaf(ca, "abc123.gr7.us-east-1.eks.amazonaws.com");

        ClusterCa.Validate(ca, leaf, null, SslPolicyErrors.RemoteCertificateChainErrors).Should().BeTrue();
        ClusterCa.Validate(other, leaf, null, SslPolicyErrors.RemoteCertificateChainErrors).Should().BeFalse();
        ClusterCa.Validate(ca, leaf, null, SslPolicyErrors.RemoteCertificateNameMismatch).Should().BeFalse();
        ClusterCa.Validate(ca, null, null, SslPolicyErrors.RemoteCertificateNotAvailable).Should().BeFalse();
    }

    [Fact]
    public void Cluster_ca_parses_from_base64_pem()
    {
        using var ca = SelfSignedCa("cluster-ca");
        var data = Convert.ToBase64String(Encoding.UTF8.GetBytes(ca.ExportCertificatePem()));
        using var parsed = ClusterCa.FromBase64Pem(data);
        parsed.Thumbprint.Should().Be(ca.Thumbprint);
    }

    private static X509Certificate2 SelfSignedCa(string cn)
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var req = new CertificateRequest($"CN={cn}", key, HashAlgorithmName.SHA256);
        req.CertificateExtensions.Add(new X509BasicConstraintsExtension(true, false, 0, true));
        req.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.KeyCertSign | X509KeyUsageFlags.CrlSign, true));
        req.CertificateExtensions.Add(new X509SubjectKeyIdentifierExtension(req.PublicKey, false));
        return req.CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddDays(30));
    }

    private static X509Certificate2 IssueLeaf(X509Certificate2 ca, string dns)
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var req = new CertificateRequest($"CN={dns}", key, HashAlgorithmName.SHA256);
        req.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, false));
        req.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.DigitalSignature, true));
        req.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension(new OidCollection { new Oid("1.3.6.1.5.5.7.3.1") }, false));
        var san = new SubjectAlternativeNameBuilder();
        san.AddDnsName(dns);
        req.CertificateExtensions.Add(san.Build());
        var serial = RandomNumberGenerator.GetBytes(8);
        return req.Create(ca, DateTimeOffset.UtcNow.AddHours(-1), DateTimeOffset.UtcNow.AddDays(7), serial);
    }
}
