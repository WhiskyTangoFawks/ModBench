using System.Text.Json;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;

namespace MEditService.Commands.Tests.Edits;

public sealed class UnreadablePluginSourceTests
{
    private static void DeleteTheSourceOf(string modFolder, string pluginFileName) =>
        Directory.Delete(Path.Combine(modFolder, "plugin-source", pluginFileName), recursive: true);

    [Fact]
    public void EditingAPlugin_WhoseSourceIsUnreadable_IsRefusedBeforeAnyWrite_NamingDecompile()
    {
        using var mod = SourceEditFixture.Tracked();
        DeleteTheSourceOf(mod.ModFolder, SourceEditFixture.PluginName);

        var result = mod.EditHandler.Set(mod.Plugin, mod.Npc.ToString(), "HeightMax", JsonDocument.Parse("0.75").RootElement);

        Assert.Equal(RecordEditRefusal.PluginSourceUnreadable, result.Refusal);
        Assert.Contains("Decompile the plugin", result.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void CopyingFromAPlugin_WhoseSourceIsUnreadable_ReadsItsPluginFile()
    {
        using var mod = ContainerCopyFixture.CreateWithTrackedSource();
        DeleteTheSourceOf(mod.SourceModFolder, ContainerCopyFixture.SourcePluginName);

        var result = mod.CopyHandler.CopyAsOverride(mod.SourcePlugin, mod.FlatNpc.ToString(), mod.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        Assert.Equal([mod.FlatNpc.ToString()], mod.ChangedFormKeys(mod.DestinationPlugin));
    }
}
