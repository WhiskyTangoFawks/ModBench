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
