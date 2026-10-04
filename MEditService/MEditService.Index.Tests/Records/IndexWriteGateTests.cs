namespace MEditService.Index.Tests.Records;

public sealed class IndexWriteGateTests
{
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
