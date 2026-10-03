using System.Collections.Concurrent;

namespace MEditService.Index.Tests.Records;

public sealed class IndexWriteGateTests
{
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

    [Fact]
    public void TheSameThread_CanEnterTwice()
    {
        var gate = new IndexWriteGate(TimeSpan.FromMilliseconds(200));

        using var outer = gate.Enter();
        var nestedAsAValidationCallingIndexDoorsDoes = Record.Exception(() =>
        {
            using var inner = gate.Enter();
        });

        Assert.Null(nestedAsAValidationCallingIndexDoorsDoes);
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
