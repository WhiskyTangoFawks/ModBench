using MEditService.Index;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Index.Tests.Records;

// ADR-0009 invariant 5's Refresh: a rebuild drops every trace of what the file held, because it must
// fix a row no hash-validate can (a wrong but self-consistent body). The next reconcile fills the file cold.
public sealed class StoreRebuildTests : IDisposable
{
    private readonly ScatteredFixtureData _fixture = new PluginFixtureBuilder("store-rebuild")
        .WithPlugin("UFO4P.esp", mod => mod.Npcs.AddNew("NpcBeforeRebuild"), origin: "Unofficial Patch")
        .BuildScattered();

    private readonly LoadOrderHolder _holder = new();
    private readonly GatedPluginAdapter _opens = new();
    private readonly IndexProjector _index;

    public StoreRebuildTests() => _index = Indexes.Open(_holder, _opens);

    public void Dispose()
    {
        _index.Dispose();
        _opens.Dispose();
        _fixture.Dispose();
    }

    private PluginCopyKey Key => _fixture.Plugins.Single().KeyOf();

    private void Reconcile(string? instanceRoot) =>
        _index.Reconcile(_holder, _fixture.GameDirectory, _fixture.Plugins, GameRelease.Fallout4, instanceRoot);

    [Fact]
    public void AnEmptySnapshot_ReconcilesToAnIndexThatAnswersNothing()
    {
        _index.Reconcile(_holder, _fixture.GameDirectory, [], GameRelease.Fallout4);

        var result = _index.RequireReads().Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 1, Offset: 0));
        Assert.Equal(0, result.Total);
    }

    // An index handed no instance has nowhere to keep a file and says so by being in-memory rather
    // than by guessing a home.
    [Fact]
    public void WithNoInstanceRoot_NothingIsKeptBetweenIndexes()
    {
        Reconcile(instanceRoot: null);
        Assert.Equal(1, _opens.OpenedTotal);
        _index.Dispose();

        using var next = Indexes.Open(_holder, _opens);
        next.Reconcile(_holder, _fixture.GameDirectory, _fixture.Plugins, GameRelease.Fallout4);

        Assert.Equal(2, _opens.OpenedTotal);
    }

    [Fact]
    public void Rebuild_DropsEveryRow_SoTheNextReconcileReadsThePluginAgain()
    {
        Reconcile(_fixture.InstanceRoot);
        Assert.Equal(1, _opens.OpenedTotal);

        _index.RebuildStore(GameRelease.Fallout4, _fixture.InstanceRoot);

        Assert.Throws<NoLoadOrderException>(() => _index.RequireReads());
        Assert.Equal(LoadOrderState.None, _index.Status.State);
        Reconcile(_fixture.InstanceRoot);
        Assert.Equal(2, _opens.OpenedTotal);
        Assert.NotEmpty(_index.RequireReads().GetDocuments(Key));
    }

    // The process may already have answered a caller with a sequence value the fresh file's own
    // table does not know about; the rebuild must never let Sequence regress within one process.
    [Fact]
    public void Rebuild_SeedsTheSequence_AtLeastTheValueAlreadyHandedOut()
    {
        Reconcile(_fixture.InstanceRoot);
        var priorSequence = _index.Sequence;
        Assert.True(priorSequence > 0, "sanity: indexing must have advanced the sequence past 0");

        _index.RebuildStore(GameRelease.Fallout4, _fixture.InstanceRoot);
        Reconcile(_fixture.InstanceRoot);

        Assert.True(_index.Sequence > priorSequence,
            $"rebuilt sequence {_index.Sequence} regressed below the prior process value {priorSequence}");
    }

    // ADR-0009 invariant 5: the same refusal PutLoadOrder answers with, at the seam that actually
    // guards it — deleting an open file succeeds on POSIX and destroys a live index.
    [ForeignIndexHolderFact]
    public void Rebuild_RefusesAndNeverDeletes_WhenAnotherProcessHoldsTheFile()
    {
        using (var earlier = Indexes.Open(new LoadOrderHolder(), _opens))
            earlier.Reconcile(new LoadOrderHolder(), _fixture.GameDirectory, _fixture.Plugins, GameRelease.Fallout4, _fixture.InstanceRoot);
        var indexPath = IndexFiles.In(_fixture.InstanceRoot);
        var bytesBeforeHold = File.ReadAllBytes(indexPath);
        using var otherWindow = ForeignIndexHolder.Hold(indexPath);

        Assert.Throws<IndexHeldElsewhereException>(() => _index.RebuildStore(GameRelease.Fallout4, _fixture.InstanceRoot));

        Assert.True(File.Exists(indexPath), "the file must still exist — a refusal must never delete it");
        Assert.Equal(bytesBeforeHold, File.ReadAllBytes(indexPath));
    }

    // Disposing a store under a read in flight is a native crash, not an exception: the rebuild
    // waits the readers out, and this test finishing at all is the assertion.
    [Fact]
    public async Task ARebuildWithReadsInFlight_CompletesAndLeavesNothingOfTheOldRows()
    {
        Reconcile(_fixture.InstanceRoot);
        using var rebuilding = new CancellationTokenSource();
        var answered = 0;
        var readers = Enumerable.Range(0, 4).Select(_ => Task.Run(() =>
        {
            while (!rebuilding.IsCancellationRequested)
            {
                try
                {
                    if (_index.RequireReads().GetDocuments(Key) is { Count: > 0 }) Interlocked.Increment(ref answered);
                }
                catch (Exception ex) when (ex is ObjectDisposedException or InvalidOperationException)
                {
                    // The scope closed under the read: the answer the reader gets is "no store", not a crash.
                }
            }
        })).ToArray();

        Assert.True(await Waits.Until(() => Volatile.Read(ref answered) > 0), "no read ever landed before the rebuild");
        _index.RebuildStore(GameRelease.Fallout4, _fixture.InstanceRoot);
        await rebuilding.CancelAsync();
        await Task.WhenAll(readers);
        Reconcile(_fixture.InstanceRoot);
        Assert.Equal(2, _opens.OpenedTotal);
    }
}
