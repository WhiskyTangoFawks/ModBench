namespace MEditService.Http.Tests.TestSupport;

/// <summary>The system's clock a day on, so each file a test wrote is long settled when the service reads it.</summary>
internal sealed class ADayAhead : TimeProvider
{
    public override DateTimeOffset GetUtcNow() => System.GetUtcNow().AddDays(1);
}
