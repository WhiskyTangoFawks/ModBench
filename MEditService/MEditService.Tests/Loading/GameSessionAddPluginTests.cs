using MEditService.Core.Session;
using Mutagen.Bethesda;

namespace MEditService.Tests.Loading;

public sealed class GameSessionAddPluginTests : IClassFixture<TestPluginFixture>
{
    private readonly TestPluginFixture _fixture;

    public GameSessionAddPluginTests(TestPluginFixture fixture) => _fixture = fixture;

    [Fact]
    public void AddPlugin_IncreasesPluginCount()
    {
        using var session = new GameSession(
            _fixture.DataFolder, _fixture.PluginsTxtPath, GameRelease.Fallout4);
        var countBefore = session.Plugins.Count;

        var newPluginPath = Path.Combine(_fixture.DataFolder, "NewEmpty.esp");
        WriteEmptyPlugin(newPluginPath, GameRelease.Fallout4);

        session.AddPlugin(newPluginPath);

        Assert.Equal(countBefore + 1, session.Plugins.Count);
    }

    [Fact]
    public void AddPlugin_NewEmptyPlugin_AppearsInPluginsWithCorrectIndex()
    {
        using var session = new GameSession(
            _fixture.DataFolder, _fixture.PluginsTxtPath, GameRelease.Fallout4);
        var expectedIndex = session.Plugins.Count;

        var newPluginPath = Path.Combine(_fixture.DataFolder, "NewEmpty.esp");
        WriteEmptyPlugin(newPluginPath, GameRelease.Fallout4);

        var metadata = session.AddPlugin(newPluginPath);

        Assert.Equal("NewEmpty.esp", metadata.Name);
        Assert.Equal(expectedIndex, metadata.LoadOrderIndex);
        Assert.Contains(session.Plugins, p => p.Name == "NewEmpty.esp");
    }

    [Fact]
    public void AddPlugin_NewEmptyPlugin_GetModReturnsIt()
    {
        using var session = new GameSession(
            _fixture.DataFolder, _fixture.PluginsTxtPath, GameRelease.Fallout4);

        var newPluginPath = Path.Combine(_fixture.DataFolder, "NewEmpty.esp");
        WriteEmptyPlugin(newPluginPath, GameRelease.Fallout4);

        session.AddPlugin(newPluginPath);

        Assert.NotNull(session.GetMod("NewEmpty.esp"));
    }

    private static void WriteEmptyPlugin(string path, GameRelease release)
    {
        var modKey = Mutagen.Bethesda.Plugins.ModKey.FromFileName(Path.GetFileName(path));
        var mod = Mutagen.Bethesda.Plugins.Records.ModFactory.Activator(modKey, release);
        mod.WriteToBinary(path);
    }
}
