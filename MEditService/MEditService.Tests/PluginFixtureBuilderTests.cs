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

    [Fact]
    public void Build_WritesPluginsTxt_WithListedPlugin()
    {
        using var data = new PluginFixtureBuilder()
            .WithPlugin("TestPlugin.esp")
            .Build();

        var content = File.ReadAllText(data.PluginsTxtPath);
        Assert.Contains("*TestPlugin.esp", content);
    }

    [Fact]
    public void Build_UnlistedPlugin_NotInPluginsTxt()
    {
        using var data = new PluginFixtureBuilder()
            .WithPlugin("Fallout4.esm", listed: false)
            .WithPlugin("UserMod.esp")
            .Build();

        var content = File.ReadAllText(data.PluginsTxtPath);
        Assert.DoesNotContain("Fallout4.esm", content);
        Assert.Contains("*UserMod.esp", content);
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
        // Written one directory above DataFolder (#434) — where Mutagen's own
        // CreationClubListings.GetListingsPath expects it relative to the Data path a session is
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
