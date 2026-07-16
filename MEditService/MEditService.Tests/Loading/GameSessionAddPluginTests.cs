using MEditService.Core.Session;
using Mutagen.Bethesda;

namespace MEditService.Tests.Loading;

[Collection(TestPluginFixtureCollection.Name)]
public sealed class GameSessionAddPluginTests(TestPluginFixture fixture)
{
    private readonly TestPluginFixture _fixture = fixture;

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

    [Fact]
    public void AddPlugin_IsImmutableAlwaysFalse()
    {
        using var session = new GameSession(
            _fixture.DataFolder, _fixture.PluginsTxtPath, GameRelease.Fallout4);

        var newPluginPath = Path.Combine(_fixture.DataFolder, "Immutable.esp");
        WriteEmptyPlugin(newPluginPath, GameRelease.Fallout4);

        var metadata = session.AddPlugin(newPluginPath);

        Assert.False(metadata.IsImmutable);
    }

    [Fact]
    public void AddPlugin_EslExtension_HasIsLightTrue()
    {
        using var session = new GameSession(
            _fixture.DataFolder, _fixture.PluginsTxtPath, GameRelease.Fallout4);

        var newPluginPath = Path.Combine(_fixture.DataFolder, "Added.esl");
        WriteEmptyPlugin(newPluginPath, GameRelease.Fallout4);

        var metadata = session.AddPlugin(newPluginPath);

        Assert.True(metadata.IsLight);
        Assert.False(metadata.IsMaster);
    }

    [Fact]
    public void AddPlugin_EsmExtension_HasIsMasterTrue()
    {
        using var session = new GameSession(
            _fixture.DataFolder, _fixture.PluginsTxtPath, GameRelease.Fallout4);

        var newPluginPath = Path.Combine(_fixture.DataFolder, "Added.esm");
        WriteEmptyPlugin(newPluginPath, GameRelease.Fallout4);

        var metadata = session.AddPlugin(newPluginPath);

        Assert.True(metadata.IsMaster);
        Assert.False(metadata.IsLight);
    }

    [Fact]
    public void AddPlugin_RecordCount_MatchesPluginContents()
    {
        using var data = new PluginFixtureBuilder("gs-add-rcount")
            .WithPlugin("Base.esp")
            .WithPlugin("With2Npcs.esp", mod => { mod.Npcs.AddNew("Npc1"); mod.Npcs.AddNew("Npc2"); }, listed: false)
            .Build();
        using var session = new GameSession(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
        var pluginPath = Path.Combine(data.DataFolder, "With2Npcs.esp");

        var metadata = session.AddPlugin(pluginPath);

        Assert.Equal(2, metadata.RecordCount);
    }

    [Fact]
    public void AddPlugin_CalledTwice_SecondPluginHasNextLoadOrderIndex()
    {
        using var session = new GameSession(
            _fixture.DataFolder, _fixture.PluginsTxtPath, GameRelease.Fallout4);

        var firstPath = Path.Combine(_fixture.DataFolder, "First.esp");
        var secondPath = Path.Combine(_fixture.DataFolder, "Second.esp");
        WriteEmptyPlugin(firstPath, GameRelease.Fallout4);
        WriteEmptyPlugin(secondPath, GameRelease.Fallout4);

        var first = session.AddPlugin(firstPath);
        var second = session.AddPlugin(secondPath);

        Assert.Equal(first.LoadOrderIndex + 1, second.LoadOrderIndex);
    }

    [Fact]
    public void AddPlugin_MetadataFields_MatchConstructorPathForSamePlugin()
    {
        using var data = new PluginFixtureBuilder("gs-add-consistency")
            .WithPlugin("Base.esm", listed: false)
            .WithPlugin("WithContent.esp", mod =>
            {
                mod.ModHeader.MasterReferences.Add(new Mutagen.Bethesda.Plugins.Records.MasterReference
                {
                    Master = Mutagen.Bethesda.Plugins.ModKey.FromFileName("Base.esm")
                });
                mod.Npcs.AddNew("Npc1");
                mod.Npcs.AddNew("Npc2");
            })
            .Build();

        using var constructorSession = new GameSession(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
        var constructorMetadata = constructorSession.Plugins.Single(p => p.Name == "WithContent.esp");

        using var addPluginSession = new GameSession(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
        var pluginPath = Path.Combine(data.DataFolder, "WithContent.esp");
        var addPluginMetadata = addPluginSession.AddPlugin(pluginPath);

        Assert.Equal(constructorMetadata.RecordCount, addPluginMetadata.RecordCount);
        Assert.Equal(constructorMetadata.Masters, addPluginMetadata.Masters);
        Assert.Equal(constructorMetadata.IsLight, addPluginMetadata.IsLight);
        Assert.Equal(constructorMetadata.IsMaster, addPluginMetadata.IsMaster);
    }

    private static void WriteEmptyPlugin(string path, GameRelease release)
    {
        var modKey = Mutagen.Bethesda.Plugins.ModKey.FromFileName(Path.GetFileName(path));
        var mod = Mutagen.Bethesda.Plugins.Records.ModFactory.Activator(modKey, release);
        mod.WriteToBinary(path);
    }
}
