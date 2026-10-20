namespace MEditService.PluginAdapter.Tests.PluginAdapter;

public sealed class LoadFailureReasonTests
{
    [Fact]
    public void NestedException_ReasonHoldsEveryMessageInTheChain_OutermostFirst()
    {
        var inner = new FormatException("inner boom");
        var outer = new InvalidOperationException("outer boom", inner);

        var reason = LoadFailureReason.Of(outer);

        Assert.Contains("outer boom", reason);
        Assert.Contains("inner boom", reason);
        Assert.True(reason.IndexOf("outer boom", StringComparison.Ordinal) <
                    reason.IndexOf("inner boom", StringComparison.Ordinal));
    }

    [Fact]
    public void NestedException_ReasonNamesEveryExceptionType()
    {
        var outer = new InvalidOperationException("outer boom", new FormatException("inner boom"));

        var reason = LoadFailureReason.Of(outer);

        Assert.Contains(nameof(InvalidOperationException), reason);
        Assert.Contains(nameof(FormatException), reason);
    }

    [Fact]
    public void SingleException_ReasonHoldsItsMessage()
    {
        var reason = LoadFailureReason.Of(new InvalidOperationException("only one"));

        Assert.Contains("only one", reason);
    }
}
