namespace MEditService.Tests.TestSupport;

/// <summary>A clock a test sets explicitly, for a production seam that takes a TimeProvider.</summary>
public sealed class FakeTimeProvider(DateTimeOffset start) : TimeProvider
{
    private DateTimeOffset _utcNow = start;

    public void SetUtcNow(DateTimeOffset value) => _utcNow = value;

    public override DateTimeOffset GetUtcNow() => _utcNow;
}
