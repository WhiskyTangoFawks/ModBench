using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Index.Tests.Plugins;

/// <summary>A "gone from disk" report can outlive the load order it was watching: a superseded watch
/// still names the plugin key, which the next load order may hold at another path.</summary>
public sealed class GoneReportChecksDiskTests : IDisposable
{
    private readonly PluginFixtureData _data = new PluginFixtureBuilder()
        .WithPlugin("Held.esp", mod => mod.Npcs.AddNew("HeldNpc"))
        .Build();

    private readonly LoadOrderHolder _holder = new();
    private readonly Indexer _index;

    private PluginAddress Key => new(_data.Plugins[0].Name, _data.Plugins[0].Origin);
    private string HeldPath => _data.Plugins[0].Path;

    public GoneReportChecksDiskTests()
    {
        _index = Indexes.Open(_holder);
        _index.Reconcile(_holder, _data.DataFolder, _data.Plugins, GameRelease.Fallout4);
    }

    public void Dispose()
    {
        _index.Dispose();
        _data.Dispose();
    }

    private int HeldRows() => _index.Projected().GetRecordTypeCounts(Key).Sum(c => c.Count);

    [Fact]
    public async Task AGoneReport_WhileTheHeldPluginIsStillOnDisk_KeepsItsRows()
    {
        Assert.True(HeldRows() > 0, "positive control: the plugin indexed");

        await _index.RefreshBinary(Key, Path.Combine(_data.DataFolder, "a-superseded-path", Key.Name));

        Assert.True(HeldRows() > 0, "a stale 'gone from disk' report removed a plugin that is still on disk");
    }

    [Fact]
    public async Task AGoneReport_OnceTheHeldPluginIsGone_RemovesItsRows()
    {
        File.Delete(HeldPath);

        await _index.RefreshBinary(Key, HeldPath);

        Assert.Equal(0, HeldRows());
    }
}
