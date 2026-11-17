using System.Diagnostics;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.RecordIndex.Tests.Query;

public sealed class AbandonedReadTests : IDisposable
{
    private const string Master = "Master.esm";
    internal const string ForeverSelect = "SELECT max(hash(a.range + b.range)) AS v FROM range(1000000) a, range(1000000) b";
    private static readonly TimeSpan WellBeforeTheSelectCouldEnd = TimeSpan.FromSeconds(20);

    private readonly PluginFixtureData _fixture = new PluginFixtureBuilder("abandoned-read").WithPlugin(Master).Build();

    public void Dispose() => _fixture.Dispose();

    private OpenedIndex Index() => Indexes.Reconciled(_fixture, _fixture.InstanceRoot, new MadeUpAdapter((Master, () => [])));

    [Fact]
    public async Task ASelectWhoseCallerLeft_StopsWorkingWithinASecond()
    {
        using var index = Index();
        using var left = new CancellationTokenSource();
        var read = Task.Run(() => index.Queries.SelectRows(ForeverSelect, left.Token));
        await Task.Delay(3000);

        var abandoned = Stopwatch.StartNew();
        await left.CancelAsync();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => read.WaitAsync(WellBeforeTheSelectCouldEnd));
        Assert.True(abandoned.Elapsed < TimeSpan.FromSeconds(1), $"The read went on for {abandoned.Elapsed.TotalSeconds:F1} s after its caller left.");
    }

    [Fact]
    public async Task ARowsStreamWhoseCallerLeft_StopsAtItsNextRow()
    {
        using var index = Index();
        using var left = new CancellationTokenSource();
        using var rows = index.Queries.SelectRows("SELECT n FROM range(10000000) t(n)", left.Token).Value();
        using var taken = rows.Rows().GetEnumerator();
        Assert.True(taken.MoveNext());

        await left.CancelAsync();

        Assert.Throws<OperationCanceledException>(() => taken.MoveNext());
    }

    [Fact]
    public void AReadWhoseCallerHasLeft_StartsNoQuery()
    {
        using var index = Index();
        using var left = new CancellationTokenSource();
        left.Cancel();

        Assert.Throws<OperationCanceledException>(() => index.Queries.GetPlugins(null, left.Token));
    }
}
