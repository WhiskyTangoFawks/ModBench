using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.TestSupport;

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

    [Fact]
    public void Build_PutsAListedPluginInTheLoadOrder_Active()
    {
        using var data = new PluginFixtureBuilder()
            .WithPlugin("TestPlugin.esp")
            .Build();

        var plugin = Assert.Single(data.Plugins);
        Assert.Equal("TestPlugin.esp", plugin.Name);
        Assert.Equal([plugin.Key], SnapshotPlugins.Active(data.Plugins));
    }

    [Fact]
    public void BuildScattered_TheGamesMasters_LoadFirst_FromTheGameDirectory()
    {
        using var data = new PluginFixtureBuilder()
            .WithPlugin("UserMod.esp", origin: "UserMod")
            .WithPlugin("Fallout4.esm")
            .BuildScattered();

        Assert.Equal(
            ["Fallout4.esm", "UserMod.esp"],
            SnapshotPlugins.Active(data.Plugins).Select(p => p.Name));
        Assert.Equal(Path.Combine(data.GameDirectory, "Fallout4.esm"), data.Plugins.Single(p => p.Name == "Fallout4.esm").Path);
    }

    [Fact]
    public void BuildScattered_TwoCopiesOfAFilename_TheLaterModWins_AndTheOtherLoadsInItsSlot()
    {
        using var data = new PluginFixtureBuilder()
            .WithPlugin("Shared.esp", origin: "ModA")
            .WithPlugin("Other.esp", origin: "OtherMod")
            .WithPlugin("Shared.esp", origin: "ModB")
            .BuildScattered();

        var overridden = data.Plugins.Single(p => p.Origin == "ModA");
        var winner = data.Plugins.Single(p => p.Origin == "ModB");
        Assert.True(winner.Winning);
        Assert.False(overridden.Winning);
        Assert.Equal(winner.Slot, overridden.Slot);
        Assert.True(data.Plugins.Single(p => p.Origin == "OtherMod").Winning);
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
