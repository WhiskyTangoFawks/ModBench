using MEditService.Ports;

namespace MEditService.Ports.Tests.Plugins;

// A reason built from a bare ex.Message loses the cause whenever Mutagen wraps a parse error inside
// an outer "failed to read" exception.
public sealed class PluginLoadFailureReasonTests
{
    [Fact]
    public void ReasonFor_NestedException_ContainsEveryMessageInTheChain_OutermostFirst()
    {
        var inner = new FormatException("inner boom");
        var outer = new InvalidOperationException("outer boom", inner);

        var reason = PluginLoadFailure.ReasonFor(outer);

        Assert.Contains("outer boom", reason);
        Assert.Contains("inner boom", reason);
        Assert.True(reason.IndexOf("outer boom", StringComparison.Ordinal) <
                    reason.IndexOf("inner boom", StringComparison.Ordinal));
    }

    [Fact]
    public void ReasonFor_NestedException_IncludesExceptionTypeNames()
    {
        var outer = new InvalidOperationException("outer boom", new FormatException("inner boom"));

        var reason = PluginLoadFailure.ReasonFor(outer);

        Assert.Contains(nameof(InvalidOperationException), reason);
        Assert.Contains(nameof(FormatException), reason);
    }

    [Fact]
    public void ReasonFor_SingleException_IsNotBlank()
    {
        var reason = PluginLoadFailure.ReasonFor(new InvalidOperationException("only one"));

        Assert.Contains("only one", reason);
    }
}
