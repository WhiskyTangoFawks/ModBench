using System.Collections.Concurrent;
using MEditService.Index;
using MEditService.Index.Tests.TestSupport;
using MEditService.TestSupport;
using MEditService.TestSupport.TestSupport;

namespace MEditService.Index.Tests.Records;

public sealed class IndexWriteGateTests
{
    // Absence by order, never by elapsed time: the first caller releases only once it has heard
    // the second is attempting entry, so a non-exclusive gate shows "second-in" before "first-out".
    [Fact]
    public async Task ASecondCaller_EntersOnlyAfterTheFirstReleases()
    {
        var gate = new IndexWriteGate();
        var order = new ConcurrentQueue<string>();
        using var firstIsIn = new ManualResetEventSlim();
        using var secondAttempting = new ManualResetEventSlim();

        var first = Task.Run(() =>
        {
            using var _ = gate.Enter();
            order.Enqueue("first-in");
            firstIsIn.Set();
            Assert.True(secondAttempting.Wait(TimeSpan.FromSeconds(5)));
            order.Enqueue("first-out");
        });

        Assert.True(firstIsIn.Wait(TimeSpan.FromSeconds(5)));
        var second = Task.Run(() =>
        {
            secondAttempting.Set();
            using var _ = gate.Enter();
            order.Enqueue("second-in");
        });

        await Task.WhenAll(first, second).WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal(["first-in", "first-out", "second-in"], order);
    }

    // Reentrancy is load-bearing: the source watcher's batch takes the gate and then calls Index
    // doors that take it again, so a non-reentrant gate would self-deadlock on the ordinary path.
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
