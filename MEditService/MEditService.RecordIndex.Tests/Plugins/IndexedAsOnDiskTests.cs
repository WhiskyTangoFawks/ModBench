using MEditService.LoadOrder;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Tests.Plugins;

public sealed class IndexedAsOnDiskTests
{
    private static readonly PluginAddress Patch = new("Patch.esp", PluginOrigin.DataDirectory);

    [Fact]
    public void APluginRewrittenSinceItWasIndexed_IsNotIndexedAsOnDisk_ThoughItsNameIsIndexed()
    {
        var holder = new LoadOrderHolder();
        using var data = new PluginFixtureBuilder("as-on-disk").WithPlugin("Patch.esp", m => m.Npcs.AddNew("Old")).Build();
        using var index = Indexes.Open(holder);
        index.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);
        Assert.Contains(Patch, index.Status.IndexedPlugins);
        Assert.True(index.Queries.GetPluginIndexedAsOnDisk(Patch).Value());

        PluginBinaries.Rewrite(Path.Combine(data.DataFolder, "Patch.esp"), m => m.Npcs.AddNew("New"));

        Assert.Contains(Patch, index.Status.IndexedPlugins);
        Assert.False(index.Queries.GetPluginIndexedAsOnDisk(Patch).Value());
    }

    [Fact]
    public void APluginTheIndexHoldsNoRowsFor_IsNotIndexedAsOnDisk()
    {
        var holder = new LoadOrderHolder();
        using var data = new PluginFixtureBuilder("as-on-disk-none").WithPlugin("Patch.esp").Build();
        using var index = Indexes.Open(holder);
        index.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);

        Assert.False(index.Queries.GetPluginIndexedAsOnDisk(new PluginAddress("Other.esp", PluginOrigin.DataDirectory)).Value());
    }
}
