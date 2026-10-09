using System.Text.Json;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;

namespace MEditService.Commands.Tests.Edits;

public sealed class UnreadablePluginSourceTests
{
    private static void DeleteTheSourceOf(string modFolder, string pluginFileName) =>
        Directory.Delete(PluginSourceRoot.In(modFolder, pluginFileName), recursive: true);

    private static bool HoldsASourceFor(string modFolder, string pluginFileName) =>
        Directory.Exists(PluginSourceRoot.In(modFolder, pluginFileName));

    [Fact]
    public void EditingAPlugin_WhoseSourceIsUnreadable_IsRefusedBeforeAnyWrite_NamingDecompile()
    {
        using var mod = SourceEditFixture.Tracked();
        DeleteTheSourceOf(mod.ModFolder, SourceEditFixture.PluginName);

        var result = mod.EditHandler.Set(mod.Plugin, mod.Npc.ToString(), "HeightMax", JsonDocument.Parse("0.75").RootElement);

        Assert.Equal(RecordEditRefusal.PluginSourceUnreadable, result.Refusal);
        Assert.Contains("Decompile the plugin", result.Message, StringComparison.Ordinal);
        Assert.False(HoldsASourceFor(mod.ModFolder, SourceEditFixture.PluginName));
    }

    [Fact]
    public void CreatingARecordInAPlugin_WhoseSourceIsUnreadable_IsRefusedTheSameWay()
    {
        using var mod = SourceEditFixture.Tracked();
        DeleteTheSourceOf(mod.ModFolder, SourceEditFixture.PluginName);

        var result = mod.CreateHandler.CreateRecordSync(mod.Plugin, "npc_");

        Assert.Equal(RecordEditRefusal.PluginSourceUnreadable, result.Refusal);
        Assert.False(HoldsASourceFor(mod.ModFolder, SourceEditFixture.PluginName));
    }

    [Fact]
    public void CopyingOntoAPlugin_WhoseSourceIsUnreadable_IsRefusedTheSameWay()
    {
        using var mod = ContainerCopyFixture.CreateWithTrackedSource();
        DeleteTheSourceOf(mod.DestinationModFolder, ContainerCopyFixture.DestinationPluginName);

        var result = mod.CopyHandler.CopySync([new RecordAt(mod.SourcePlugin, mod.FlatNpc.ToString())], CopyMode.Override, [mod.DestinationPlugin], replace: false);

        var refused = result.OnlyRefused();
        Assert.Equal(RecordEditRefusal.PluginSourceUnreadable, refused.Refusal);
        Assert.False(HoldsASourceFor(mod.DestinationModFolder, ContainerCopyFixture.DestinationPluginName));
    }

    [Fact]
    public void CopyingFromAPlugin_WhoseSourceIsUnreadable_ReadsItsPluginFile()
    {
        using var mod = ContainerCopyFixture.CreateWithTrackedSource();
        DeleteTheSourceOf(mod.SourceModFolder, ContainerCopyFixture.SourcePluginName);

        var result = mod.CopyHandler.CopySync([new RecordAt(mod.SourcePlugin, mod.FlatNpc.ToString())], CopyMode.Override, [mod.DestinationPlugin], replace: false);

        result.OnlyLanded();
        Assert.Equal([mod.FlatNpc.ToString()], mod.ChangedFormKeys(mod.DestinationPlugin));
    }
}
