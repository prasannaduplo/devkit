using System.Text.Json.Nodes;
using Amazon.EC2;
using Amazon.EC2.Model;
using Duplo.Extension.NetMap.Core.Aws;
using Duplo.Extension.NetMap.Core.Graph;
using FluentAssertions;
using Xunit;

namespace Duplo.Extension.NetMap.Tests;

public class SanitizerTests
{
    [Fact]
    public void Removes_denied_keys_at_any_depth()
    {
        var o = JsonNode.Parse("""
            {"a":1,"PreSharedKey":"x","Options":{"TunnelOptions":[{"OutsideIpAddress":"1.2.3.4","PreSharedKey":"y"}]},
             "nested":{"AdminPassword":"z","ClientSecret":"w","keep":"k"}}
            """)!.AsObject();

        Sanitizer.Sanitize(o);

        var json = o.ToJsonString();
        json.Should().NotContain("PreSharedKey").And.NotContain("AdminPassword").And.NotContain("ClientSecret");
        json.Should().Contain("OutsideIpAddress").And.Contain("\"keep\":\"k\"");
    }

    [Fact]
    public void Removes_workload_environment_and_secrets()
    {
        var o = JsonNode.Parse("""
            {"FunctionName":"f","Environment":{"Variables":{"DB_PASSWORD":"x"}},
             "Containers":[{"Name":"c","Env":[{"name":"K","value":"v"}],"Secrets":[{"ValueFrom":"arn"}]}],"Token":"t"}
            """)!.AsObject();
        Sanitizer.Sanitize(o);
        o.ToJsonString().Should().Be("""{"FunctionName":"f","Containers":[{"Name":"c"}]}""");
    }

    [Theory]
    [InlineData("pre_shared_key")]
    [InlineData("pre-shared-key")]
    [InlineData("PRE_SHARED_KEY")]
    [InlineData("admin_password")]
    [InlineData("client-secret")]
    public void Denied_keys_are_separator_insensitive(string key) => Sanitizer.IsDenied(key).Should().BeTrue();

    [Fact]
    public void Vpn_connection_raw_never_contains_tunnel_secrets()
    {
        var vpn = new VpnConnection
        {
            VpnConnectionId = "vpn-1",
            CustomerGatewayConfiguration = "<vpn_connection><pre_shared_key>SECRET1</pre_shared_key></vpn_connection>",
            Options = new VpnConnectionOptions
            {
                TunnelOptions = new List<TunnelOption> { new() { OutsideIpAddress = "203.0.113.1", PreSharedKey = "SECRET2" } },
            },
            State = VpnState.Available,
        };

        var raw = RawJson.From(vpn).ToJsonString();

        raw.Should().NotContain("SECRET1").And.NotContain("SECRET2").And.NotContain("CustomerGatewayConfiguration");
        raw.Should().Contain("203.0.113.1");
    }

    [Fact]
    public void Constant_classes_serialize_as_plain_strings()
    {
        var raw = RawJson.From(new Vpc { VpcId = "vpc-1", State = VpcState.Available });
        raw["State"]!.GetValue<string>().Should().Be("available");
        raw["VpcId"]!.GetValue<string>().Should().Be("vpc-1");
    }
}
