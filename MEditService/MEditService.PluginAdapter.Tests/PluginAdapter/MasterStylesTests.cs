using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.PluginAdapter.Tests.PluginAdapter;

public sealed class MasterStylesTests
{
    private static readonly IPluginAdapter Adapter = TestAdapters.Mutagen();

    [Fact]
    public void APluginWhoseMasterIsLight_ReadsItsOverrideAsTheMastersRecord_TheStyleReadOffTheMastersOwnHeader()
    {
        using var scratch = new ScratchDirectory("master-styles");
        var (masterPath, childPath) = LightMasterAndChild.Write(scratch.Path);
        var loadOrder = SnapshotPlugins.Snapshot(scratch.Path, null, GameRelease.Starfield,
        [
            new LoadOrderEntry(LightMasterAndChild.Master.FileName, masterPath, PluginOrigin.DataDirectory, 0, Enabled: true, Winning: true),
            new LoadOrderEntry(LightMasterAndChild.Child.FileName, childPath, PluginOrigin.DataDirectory, 1, Enabled: true, Winning: true),
        ]);

        using var documents = Adapter.OpenDocuments(
            new ModPath(LightMasterAndChild.Child, childPath), loadOrder, SharedSchemaReflector.Instance.GetSchemas(GameRelease.Starfield)).Answered();

        Assert.Equal([LightMasterAndChild.Weapon.ToString()], documents.Records.Select(r => r.FormKey));
    }
}
