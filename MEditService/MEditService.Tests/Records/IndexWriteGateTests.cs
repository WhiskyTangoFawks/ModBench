using MEditService.Core.Records;

namespace MEditService.Tests.Records;

/// <summary>
/// #673: the process-wide write gate's own three properties, at its own seam. Everything else in
/// this ticket is a call site that must take it; this file is what "it" does.
/// </summary>
public sealed class IndexWriteGateTests
{
    [Fact]
    public async Task ASecondCaller_WaitsUntilTheFirstReleases()
    {
        var gate = new IndexWriteGate();
        using var firstIsIn = new ManualResetEventSlim();
        using var secondIsIn = new ManualResetEventSlim();

        var first = Task.Run(() =>
        {
            using var _ = gate.Enter();
            firstIsIn.Set();
            // Long enough that a gateless implementation would let the second caller in meanwhile,
            // short enough not to slow the suite.
            Thread.Sleep(500);
        });

        Assert.True(firstIsIn.Wait(TimeSpan.FromSeconds(5)));
        var second = Task.Run(() =>
        {
            using var _ = gate.Enter();
            secondIsIn.Set();
        });

        Assert.False(secondIsIn.Wait(TimeSpan.FromMilliseconds(200)), "the second caller got in while the first held the gate");
        await Task.WhenAll(first, second).WaitAsync(TimeSpan.FromSeconds(10));
        Assert.True(secondIsIn.IsSet);
    }

    /// <summary>
    /// Reentrant, and load-bearing rather than incidental: a write endpoint takes the gate and then
    /// calls through to doors that take it for themselves (<c>ReindexPlugin</c> delegating to
    /// <c>ReingestPluginFromSource</c> is the shortest such chain), so a non-reentrant gate would
    /// self-deadlock on the ordinary path rather than on a race.
    /// </summary>
    [Fact]
    public void TheSameThread_CanEnterTwice()
    {
        var gate = new IndexWriteGate(TimeSpan.FromMilliseconds(200));

        using var outer = gate.Enter();
        var nested = Record.Exception(() =>
        {
            using var inner = gate.Enter();
        });

        Assert.Null(nested);
    }

    [Fact]
    public async Task AWaitThatOutlastsTheTimeout_ThrowsRatherThanBlockingForever()
    {
        var gate = new IndexWriteGate(TimeSpan.FromMilliseconds(150));
        using var held = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();

        var holder = Task.Run(() =>
        {
            using var _ = gate.Enter();
            held.Set();
            release.Wait(TimeSpan.FromSeconds(10));
        });
        Assert.True(held.Wait(TimeSpan.FromSeconds(5)));

        var thrown = Record.Exception(() =>
        {
            using var _ = gate.Enter();
        });

        release.Set();
        await holder.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.IsType<IndexWriteGateTimeoutException>(thrown);
    }
}
