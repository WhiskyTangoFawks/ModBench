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
        var loadOrder = LightMasterAndChild.LoadOrderIn(scratch.Path);

        using var documents = Adapter.OpenDocuments(
            new ModPath(LightMasterAndChild.Child, LightMasterAndChild.ChildIn(loadOrder).Path), loadOrder, SharedSchemaReflector.Instance.GetSchemas(GameRelease.Starfield), PluginStrings.None).Answered();

        Assert.Equal([LightMasterAndChild.Weapon.ToString()], documents.Records.Select(r => r.FormKey));
    }

    [Fact]
    public void APluginBesideAnUnrelatedPluginWhoseHeaderDoesNotRead_Reads()
    {
        using var scratch = new ScratchDirectory("master-styles-unrelated");
        var (masterPath, childPath) = LightMasterAndChild.Write(scratch.Path);
        var unrelatedPath = Path.Combine(scratch.Path, "Unrelated.esm");
        File.WriteAllBytes(unrelatedPath, "not a plugin"u8.ToArray());
        var loadOrder = SnapshotPlugins.Snapshot(scratch.Path, null, GameRelease.Starfield,
        [
            new LoadOrderEntry(LightMasterAndChild.Master.FileName, masterPath, PluginOrigin.DataDirectory, 0, Enabled: true, Winning: true),
            new LoadOrderEntry("Unrelated.esm", unrelatedPath, PluginOrigin.DataDirectory, 1, Enabled: true, Winning: true),
            new LoadOrderEntry(LightMasterAndChild.Child.FileName, childPath, PluginOrigin.DataDirectory, 2, Enabled: true, Winning: true),
        ]);

        using var documents = Adapter.OpenDocuments(
            new ModPath(LightMasterAndChild.Child, childPath), loadOrder, SharedSchemaReflector.Instance.GetSchemas(GameRelease.Starfield), PluginStrings.None).Answered();

        Assert.Equal([LightMasterAndChild.Weapon.ToString()], documents.Records.Select(r => r.FormKey));
    }

    [Fact]
    public void APluginWhoseMasterTheLoadOrderDoesNotHold_FailsNamingThatMaster()
    {
        using var scratch = new ScratchDirectory("master-styles-missing");
        var (_, childPath) = LightMasterAndChild.Write(scratch.Path);

        var failure = Adapter.OpenDocuments(
            new ModPath(LightMasterAndChild.Child, childPath), EmptyLoadOrder.Of(GameRelease.Starfield),
            SharedSchemaReflector.Instance.GetSchemas(GameRelease.Starfield), PluginStrings.None).Failure();

        Assert.IsType<PluginFailure.MasterNotInLoadOrder>(failure);
        Assert.Contains(LightMasterAndChild.Master.FileName.String, failure.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public void APluginWhoseMasterDoesNotRead_FailsNamingThatMaster_AndWhyItDoesNotRead()
    {
        using var scratch = new ScratchDirectory("master-styles-unreadable");
        var loadOrder = LightMasterAndChild.LoadOrderIn(scratch.Path);
        File.WriteAllBytes(Path.Combine(scratch.Path, LightMasterAndChild.Master.FileName), "not a plugin"u8.ToArray());

        var failure = Adapter.OpenDocuments(
            new ModPath(LightMasterAndChild.Child, LightMasterAndChild.ChildIn(loadOrder).Path), loadOrder,
            SharedSchemaReflector.Instance.GetSchemas(GameRelease.Starfield), PluginStrings.None).Failure();

        Assert.Equal(
            "its master Light.esm could not be read: the plugin — unknown: Could not read enough data to parse a Mod Header from stream.  Position: 0.  12 remaining < 24 expected.",
            failure.Reason);
    }
}
