using System.Security.Cryptography;
using System.Text;
using Duplo.Extension.NetMap.Core.K8s;
using FluentAssertions;
using Xunit;

namespace Duplo.Extension.NetMap.Tests;

public class EksTokenTests
{
    // AWS documentation example credentials (not real).
    private const string AccessKey = "AKIDEXAMPLE";
    private const string SecretKey = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
    private const string SessionToken = "FQoGZXIvYXdzEXAMPLE/session+token==";
    private static readonly DateTime Now = new(2024, 1, 15, 12, 34, 56, DateTimeKind.Utc);

    private static EksToken Token() => new(() => Now);

    [Fact]
    public void Official_s3_presigned_get_vector_from_the_sigv4_query_auth_docs()
    {
        // "Authenticating Requests: Using Query Parameters (AWS Signature Version 4)" - the GET test.txt example.
        var url = SigV4Presigner.Presign("GET", "examplebucket.s3.amazonaws.com", "/test.txt",
            new Dictionary<string, string>(), new Dictionary<string, string>(), SigV4Presigner.UnsignedPayload,
            "s3", "us-east-1", "AKIAIOSFODNN7EXAMPLE", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
            new DateTime(2013, 5, 24, 0, 0, 0, DateTimeKind.Utc), 86400);

        url.Should().Be("https://examplebucket.s3.amazonaws.com/test.txt" +
            "?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request" +
            "&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host" +
            "&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404");
    }

    [Fact]
    public void Matches_botocore_presign_without_session_token()
    {
        // Reference: botocore SigV4QueryAuth (the signer behind `aws eks get-token`), same inputs, frozen clock, offline.
        const string botocoreUrl = "https://sts.us-west-2.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15" +
            "&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIDEXAMPLE%2F20240115%2Fus-west-2%2Fsts%2Faws4_request" +
            "&X-Amz-Date=20240115T123456Z&X-Amz-Expires=60&X-Amz-SignedHeaders=host%3Bx-k8s-aws-id" +
            "&X-Amz-Signature=aa690359a6440c2f615df92fa58f9619a9926e607b2156481edfd8364f984429";

        Token().PresignedUrl("demo-cluster", "us-west-2", AccessKey, SecretKey, null).Should().Be(botocoreUrl);
        Token().Create("demo-cluster", "us-west-2", AccessKey, SecretKey, null).Should().Be(
            "k8s-aws-v1.aHR0cHM6Ly9zdHMudXMtd2VzdC0yLmFtYXpvbmF3cy5jb20vP0FjdGlvbj1HZXRDYWxsZXJJZGVudGl0eSZWZXJzaW9uPTIwMTEtMDYtMTUmWC1BbXotQWxnb3JpdGhtPUFXUzQtSE1BQy1TSEEyNTYmWC1BbXotQ3JlZGVudGlhbD1BS0lERVhBTVBMRSUyRjIwMjQwMTE1JTJGdXMtd2VzdC0yJTJGc3RzJTJGYXdzNF9yZXF1ZXN0JlgtQW16LURhdGU9MjAyNDAxMTVUMTIzNDU2WiZYLUFtei1FeHBpcmVzPTYwJlgtQW16LVNpZ25lZEhlYWRlcnM9aG9zdCUzQngtazhzLWF3cy1pZCZYLUFtei1TaWduYXR1cmU9YWE2OTAzNTlhNjQ0MGMyZjYxNWRmOTJmYTU4Zjk2MTlhOTkyNmU2MDdiMjE1NjQ4MWVkZmQ4MzY0Zjk4NDQyOQ");
    }

    [Fact]
    public void Matches_botocore_signature_with_session_token()
    {
        // botocore emits the token after X-Amz-SignedHeaders; we emit canonical order. The signature must agree.
        var url = Token().PresignedUrl("demo-cluster", "us-west-2", AccessKey, SecretKey, SessionToken);
        url.Should().Contain("&X-Amz-Security-Token=FQoGZXIvYXdzEXAMPLE%2Fsession%2Btoken%3D%3D&");
        url.Should().EndWith("&X-Amz-Signature=8025131b72e99fe62122c9178e73694fe635668ac7582b47584eee5960be598b");
    }

    [Fact]
    public void Signature_matches_an_independent_step_by_step_sigv4_computation()
    {
        var url = Token().PresignedUrl("demo-cluster", "eu-central-1", AccessKey, SecretKey, SessionToken);

        // 1. canonical request
        var canonicalQuery =
            "Action=GetCallerIdentity&Version=2011-06-15&X-Amz-Algorithm=AWS4-HMAC-SHA256" +
            "&X-Amz-Credential=AKIDEXAMPLE%2F20240115%2Feu-central-1%2Fsts%2Faws4_request" +
            "&X-Amz-Date=20240115T123456Z&X-Amz-Expires=60" +
            "&X-Amz-Security-Token=FQoGZXIvYXdzEXAMPLE%2Fsession%2Btoken%3D%3D" +
            "&X-Amz-SignedHeaders=host%3Bx-k8s-aws-id";
        var canonicalRequest =
            "GET\n/\n" + canonicalQuery + "\n" +
            "host:sts.eu-central-1.amazonaws.com\nx-k8s-aws-id:demo-cluster\n\n" +
            "host;x-k8s-aws-id\n" +
            Hex(SHA256.HashData(Array.Empty<byte>()));
        // 2. string to sign
        var stringToSign = "AWS4-HMAC-SHA256\n20240115T123456Z\n20240115/eu-central-1/sts/aws4_request\n" +
            Hex(SHA256.HashData(Encoding.UTF8.GetBytes(canonicalRequest)));
        // 3. signing key + signature
        var kDate = HMACSHA256.HashData(Encoding.UTF8.GetBytes("AWS4" + SecretKey), Encoding.UTF8.GetBytes("20240115"));
        var kRegion = HMACSHA256.HashData(kDate, Encoding.UTF8.GetBytes("eu-central-1"));
        var kService = HMACSHA256.HashData(kRegion, Encoding.UTF8.GetBytes("sts"));
        var kSigning = HMACSHA256.HashData(kService, Encoding.UTF8.GetBytes("aws4_request"));
        var signature = Hex(HMACSHA256.HashData(kSigning, Encoding.UTF8.GetBytes(stringToSign)));

        url.Should().Be($"https://sts.eu-central-1.amazonaws.com/?{canonicalQuery}&X-Amz-Signature={signature}");
    }

    [Fact]
    public void Token_is_prefixed_unpadded_base64url_of_the_presigned_url()
    {
        var token = Token().Create("c-1", "us-east-1", AccessKey, SecretKey, SessionToken);

        token.Should().StartWith("k8s-aws-v1.");
        var body = token["k8s-aws-v1.".Length..];
        body.Should().MatchRegex("^[A-Za-z0-9_-]+$");
        var padded = body.Replace('-', '+').Replace('_', '/');
        padded += new string('=', (4 - padded.Length % 4) % 4);
        var url = Encoding.UTF8.GetString(Convert.FromBase64String(padded));
        url.Should().Be(Token().PresignedUrl("c-1", "us-east-1", AccessKey, SecretKey, SessionToken));
        url.Should().StartWith("https://sts.us-east-1.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15&");
    }

    [Fact]
    public void Cluster_name_changes_the_signature_and_china_regions_use_the_cn_host()
    {
        Token().PresignedUrl("a", "us-east-1", AccessKey, SecretKey, null)
            .Should().NotBe(Token().PresignedUrl("b", "us-east-1", AccessKey, SecretKey, null));
        EksToken.StsHost("cn-north-1").Should().Be("sts.cn-north-1.amazonaws.com.cn");
    }

    [Fact]
    public void Uri_encoding_follows_rfc3986()
    {
        SigV4Presigner.UriEncode("Az09-_.~ /+=;:é").Should().Be("Az09-_.~%20%2F%2B%3D%3B%3A%C3%A9");
    }

    private static string Hex(byte[] b) => Convert.ToHexString(b).ToLowerInvariant();
}
