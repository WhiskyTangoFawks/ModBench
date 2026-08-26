using MEditService.Core.Session;

namespace MEditService.Tests.Session;

// #395: a load-failure reason built from a bare ex.Message loses the actual cause whenever
// Mutagen wraps a parse error (which record, which subrecord, offset) inside an outer "failed to
// read" exception. PluginLoadFailure.ReasonFor flattens the whole InnerException chain instead,
// outermost first, so the tooltip can narrow the cause down rather than repeat "failed to load".
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
