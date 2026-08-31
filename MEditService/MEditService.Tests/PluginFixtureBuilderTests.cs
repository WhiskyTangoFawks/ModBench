using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests;

public class PluginFixtureBuilderTests
{
    [Fact]
    public void Build_CreatesDataFolderWithPlugin()
    {
        using var data = new PluginFixtureBuilder()
            .WithPlugin("TestPlugin.esp")
            .Build();

        Assert.True(File.Exists(Path.Combine(data.DataFolder, "TestPlugin.esp")));
    }

    // The ordered explicit list is the load order — there is no plugins.txt path left for a
    // fixture to write one for. `listed` is what puts a plugin in that list; `enabled` is the `*`
    // prefix, i.e. Participates.
    [Fact]
    public void Build_PutsAListedPluginInTheLoadOrder_Participating()
    {
        using var data = new PluginFixtureBuilder()
            .WithPlugin("TestPlugin.esp")
            .Build();

        var plugin = Assert.Single(data.Plugins);
        Assert.Equal("TestPlugin.esp", plugin.Name);
        Assert.True(plugin.Enabled);
    }

    [Fact]
    public void Build_UnlistedPlugin_IsNotInTheLoadOrder()
    {
        using var data = new PluginFixtureBuilder()
            .WithPlugin("Fallout4.esm", listed: false)
            .WithPlugin("UserMod.esp")
            .Build();

        Assert.DoesNotContain(data.Plugins, p => p.Name == "Fallout4.esm");
        Assert.Contains(data.Plugins, p => p.Name == "UserMod.esp");
    }

    [Fact]
    public void Build_UnlistedPlugin_FileStillWrittenToDisk()
    {
        using var data = new PluginFixtureBuilder()
            .WithPlugin("Fallout4.esm", listed: false)
            .Build();

        Assert.True(File.Exists(Path.Combine(data.DataFolder, "Fallout4.esm")));
    }

    [Fact]
    public void Build_ConfigureCallback_CapturesFormKey()
    {
        FormKey captured = default;
        using var data = new PluginFixtureBuilder()
            .WithPlugin("TestPlugin.esp", mod => captured = mod.Npcs.AddNew("NPC1").FormKey)
            .Build();

        Assert.NotEqual(FormKey.Null, captured);
    }

    [Fact]
    public void Build_WithCreationClubCatalog_WritesCccFile()
    {
        // Written one directory above DataFolder — where Mutagen's own
        // CreationClubListings.GetListingsPath expects it relative to the Data path a load order is
        // given, not inside DataFolder itself.
        using var data = new PluginFixtureBuilder()
            .WithPlugin("ccTest.esl", listed: false)
            .WithCreationClubCatalog("ccTest.esl")
            .Build();

        var cccPath = Path.Combine(data.CleanupRoot, "Fallout4.ccc");
        Assert.True(File.Exists(cccPath));
        Assert.Equal("ccTest.esl", File.ReadAllText(cccPath).Trim());
    }

    [Fact]
    public void Dispose_DeletesDataFolder()
    {
        var data = new PluginFixtureBuilder()
            .WithPlugin("TestPlugin.esp")
            .Build();

        var folder = data.DataFolder;
        data.Dispose();

        Assert.False(Directory.Exists(folder));
    }
}
