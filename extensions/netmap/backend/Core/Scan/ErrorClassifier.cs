using System.Text.RegularExpressions;
using Amazon.Runtime;

namespace Duplo.Extension.NetMap.Core.Scan;

public enum ErrorKind { Denied, Transient, Error }

/// <summary>Denied → terminal for the unit, capability shows not-readable with the missing permission. Transient →
/// retried on later ticks. Error → retried, then failed after ScanEngine.MaxAttempts.</summary>
public static class ErrorClassifier
{
    private static readonly HashSet<string> DeniedCodes = new(StringComparer.OrdinalIgnoreCase)
    {
        "UnauthorizedOperation", "AccessDenied", "AccessDeniedException", "AuthorizationError", "UnauthorizedException",
    };

    private static readonly HashSet<string> TransientCodes = new(StringComparer.OrdinalIgnoreCase)
    {
        "Throttling", "ThrottlingException", "RequestLimitExceeded", "TooManyRequestsException",
        "PriorRequestNotComplete", "RequestThrottled", "ServiceUnavailable", "InternalError", "InternalFailure",
    };

    private static readonly Regex Permission = new(@"perform:\s*([a-z0-9-]+:[A-Za-z0-9]+)", RegexOptions.Compiled);

    public static (ErrorKind Kind, string? MissingPermission) Classify(Exception ex)
    {
        if (ex is AmazonServiceException aws)
        {
            var code = aws.ErrorCode ?? "";
            if (DeniedCodes.Contains(code))
            {
                var m = Permission.Match(aws.Message ?? "");
                return (ErrorKind.Denied, m.Success ? m.Groups[1].Value : null);
            }
            if (TransientCodes.Contains(code) || (int)aws.StatusCode >= 500) return (ErrorKind.Transient, null);
            return (ErrorKind.Error, null);
        }
        if (ex is OperationCanceledException or TimeoutException or HttpRequestException) return (ErrorKind.Transient, null);
        return (ErrorKind.Error, null);
    }
}
