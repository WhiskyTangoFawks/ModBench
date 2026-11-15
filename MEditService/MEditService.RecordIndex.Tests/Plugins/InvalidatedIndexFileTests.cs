using MEditService.LoadOrder;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex.Tests.Plugins;

public sealed class InvalidatedIndexFileTests : IDisposable
{
    private const string Before = "Before.esp";
    private const string Aborted = "Aborted.esp";
    private const string After = "After.esp";

    private readonly PluginFixtureData _fixture = new PluginFixtureBuilder("invalidated-index-file")
        .WithPlugin(Before, mod => mod.Npcs.AddNew("BeforeNpc"))
        .WithPlugin(Aborted, mod => mod.Npcs.AddNew("AbortedNpc"))
        .WithPlugin(After, mod => mod.Npcs.AddNew("AfterNpc"))
        .Build();

    private readonly LoadOrderHolder _holder = new();
    private readonly OpenedIndex _index;

    public InvalidatedIndexFileTests()
    {
        _index = Indexes.Open(_holder, new AbortingDuckDbsCheckpoint(_fixture.InstanceRoot, Aborted, nthRead: 2));
        _index.Reconcile(_holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4, _fixture.InstanceRoot);
        var rewritten = new Fallout4Mod(ModKey.FromFileName(Aborted), Fallout4Release.Fallout4);
        rewritten.Npcs.AddNew("RewrittenNpc");
        rewritten.WriteToBinary(_fixture.Plugins.Single(p => p.Name == Aborted).Path);
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    [Fact]
    public void AFatalErrorInTheIndexFile_IsRecoveredFrom_BlamesNoPlugin_AndEveryPluginIsRead()
    {
        _index.Recovered(() => _index.Status.IndexedPlugins.Select(p => p.Name).Order().SequenceEqual([Aborted, After, Before]), "every plugin read");

        Assert.Empty(_index.Status.Failures);
        Assert.Single(_index.ListedIn(_fixture.Plugins.Single(p => p.Name == Before).Key));
    }
}
