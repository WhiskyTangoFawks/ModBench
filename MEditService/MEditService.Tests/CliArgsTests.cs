using MEditService.Api;
using Mutagen.Bethesda;

namespace MEditService.Tests;

public class CliArgsTests
{
    [Fact]
    public void Parse_EmptyArgs_ReturnsNullFields()
    {
        var result = CliArgs.Parse([]);
        Assert.Null(result.DataFolderPath);
        Assert.Null(result.PluginsTxtPath);
    }

    [Fact]
    public void Parse_DataFolderAndPluginsTxt_ReturnsBothPaths()
    {
        var result = CliArgs.Parse(["--data-folder", "/game/Data", "--plugins-txt", "/config/Plugins.txt"]);
        Assert.Equal("/game/Data", result.DataFolderPath);
        Assert.Equal("/config/Plugins.txt", result.PluginsTxtPath);
    }

    [Fact]
    public void Parse_DataFolderOnly_ReturnsNullPluginsTxt()
    {
        var result = CliArgs.Parse(["--data-folder", "/game/Data"]);
        Assert.Equal("/game/Data", result.DataFolderPath);
        Assert.Null(result.PluginsTxtPath);
    }

    [Fact]
    public void Parse_UnknownArgs_Ignored()
    {
        var result = CliArgs.Parse(["--urls", "http://localhost:5172", "--data-folder", "/game/Data"]);
        Assert.Equal("/game/Data", result.DataFolderPath);
        Assert.Null(result.PluginsTxtPath);
    }

    [Fact]
    public void Parse_ArgOrderIndependent()
    {
        var result = CliArgs.Parse(["--plugins-txt", "/config/Plugins.txt", "--data-folder", "/game/Data"]);
        Assert.Equal("/game/Data", result.DataFolderPath);
        Assert.Equal("/config/Plugins.txt", result.PluginsTxtPath);
    }

    [Fact]
    public void Parse_GameFlag_ReturnsGameRelease()
    {
        var result = CliArgs.Parse(["--game", "Fallout4"]);
        Assert.Equal(GameRelease.Fallout4, result.GameRelease);
    }

    [Fact]
    public void Parse_NoGameFlag_NullGameRelease()
    {
        var result = CliArgs.Parse([]);
        Assert.Null(result.GameRelease);
    }

    [Fact]
    public void Parse_AllArgs_Correct()
    {
        var result = CliArgs.Parse(["--data-folder", "/game/Data", "--plugins-txt", "/Plugins.txt", "--game", "Fallout4"]);
        Assert.Equal("/game/Data", result.DataFolderPath);
        Assert.Equal("/Plugins.txt", result.PluginsTxtPath);
        Assert.Equal(GameRelease.Fallout4, result.GameRelease);
    }
}
