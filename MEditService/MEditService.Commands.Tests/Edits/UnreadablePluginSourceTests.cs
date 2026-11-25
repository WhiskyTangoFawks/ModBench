using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;

namespace MEditService.Commands.Tests.Edits;

public sealed class UnreadablePluginSourceTests
{
    private static void DeleteTheSourceOf(string modFolder, string pluginFileName) =>
        Directory.Delete(PluginSourceRoot.In(modFolder, pluginFileName), recursive: true);

    [Fact]
    public void CopyingFromAPlugin_WhoseSourceIsUnreadable_ReadsItsPluginFile()
    {
        using var mod = ContainerCopyFixture.CreateWithCompiledPluginSource();
        DeleteTheSourceOf(mod.SourceModFolder, ContainerCopyFixture.SourcePluginName);

        var result = mod.CopyHandler.CopySync([new RecordAt(mod.SourcePlugin, mod.FlatNpc.ToString())], CopyMode.Override, [mod.DestinationPlugin], replace: false);

        result.OnlyLanded();
        Assert.Equal([mod.FlatNpc.ToString()], mod.ChangedFormKeys(mod.DestinationPlugin));
    }
}
