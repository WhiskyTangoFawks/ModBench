using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Tests.Plugins;

/// <summary>A "gone from disk" report can outlive the load order it was watching: a superseded watch
/// still names the plugin key, which the next load order may hold at another path.</summary>
public sealed class UnindexPluginChecksDiskTests : IDisposable
{
    private readonly PluginFixtureData _data = new PluginFixtureBuilder()
        .WithPlugin("Held.esp", mod => mod.Npcs.AddNew("HeldNpc"))
        .Build();

    private readonly IndexProjector _index = new(
        new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));

    private PluginKey Key => new(_data.Plugins[0].Name, _data.Plugins[0].Origin);

    public UnindexPluginChecksDiskTests() =>
        _index.Reconcile(_data.DataFolder, _data.Plugins, GameRelease.Fallout4);

    public void Dispose()
    {
        _index.Dispose();
        _data.Dispose();
    }

    private int HeldRows() => _index.SettledReads().GetRecordTypeCounts(Key).Sum(c => c.Count);

    [Fact]
    public void UnindexPlugin_WhileTheHeldCopyIsStillOnDisk_KeepsItsRows()
    {
        Assert.True(HeldRows() > 0, "positive control: the plugin indexed");

        _index.UnindexPlugin(Key);

        Assert.True(HeldRows() > 0, "a stale 'gone from disk' report removed a copy that is still on disk");
    }

    [Fact]
    public void UnindexPlugin_OnceTheHeldCopyIsGone_RemovesItsRows()
    {
        File.Delete(_data.Plugins[0].Path);

        _index.UnindexPlugin(Key);

        Assert.Equal(0, HeldRows());
    }
}
