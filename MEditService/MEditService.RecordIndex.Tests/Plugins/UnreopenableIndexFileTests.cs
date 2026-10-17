using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex.Tests.Plugins;

public sealed class UnreopenableIndexFileTests : IDisposable
{
    private const string Aborted = "Aborted.esp";

    private readonly PluginFixtureData _fixture = new PluginFixtureBuilder("unreopenable-index-file")
        .WithPlugin(Aborted, mod => mod.Npcs.AddNew("AbortedNpc"))
        .Build();

    private readonly LoadOrderHolder _holder = new();
    private readonly string _indexFolder;
    private readonly OpenedIndex _index;

    public UnreopenableIndexFileTests()
    {
        _index = Indexes.Open(_holder, new AbortingDuckDbsCheckpoint(_fixture.InstanceRoot, Aborted, nthRead: 2));
        _index.Reconcile(_holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4, _fixture.InstanceRoot);
        _indexFolder = Path.GetDirectoryName(IndexFiles.In(_fixture.InstanceRoot)) ?? throw new InvalidOperationException("The index file has a folder.");
    }

    public void Dispose()
    {
        FileModes.Set(_indexFolder, "700");
        _index.Dispose();
        _fixture.Dispose();
    }

    [PosixFact]
    public void AFatalError_WhoseReopenFails_EndsInAFailedStatusThatSaysSo()
    {
        FileModes.Set(_indexFolder, "500");

        var rewritten = new Fallout4Mod(ModKey.FromFileName(Aborted), Fallout4Release.Fallout4);
        rewritten.Npcs.AddNew("RewrittenNpc");
        rewritten.WriteToBinary(_fixture.Plugins.Single().Path);

        _index.NextSnapshotUnsettledUntil(() => _index.Status.State == LoadOrderState.Failed, "the reopen failing");

        Assert.Equal(LoadOrderState.Failed, _index.Status.State);
        Assert.Contains("not reopened", _index.Status.Message, StringComparison.Ordinal);
    }
}
