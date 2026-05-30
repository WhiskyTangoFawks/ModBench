using MEditService.Core.Session;
using Mutagen.Bethesda;

namespace MEditService.Tests.Loading;

public sealed class GameSessionImplicitFixture : IDisposable
{
    public string DataFolder => _data.DataFolder;
    public string PluginsTxtPath => _data.PluginsTxtPath;
    public const string UserPluginName = "UserMod.esp";

    private readonly PluginFixtureData _data;

    public GameSessionImplicitFixture()
    {
        _data = new PluginFixtureBuilder("medit-gs")
            .WithPlugin("Fallout4.esm", listed: false)
            .WithPlugin(UserPluginName)
            .Build();
    }

    public void Dispose() => _data.Dispose();
}

public sealed class GameSessionTests : IClassFixture<GameSessionImplicitFixture>
{
    private readonly GameSessionImplicitFixture _fixture;

    public GameSessionTests(GameSessionImplicitFixture fixture)
        => _fixture = fixture;

    [Fact]
    public void ImplicitPlugin_PresentInDataFolder_IsLoaded()
    {
        using var session = new GameSession(_fixture.DataFolder, _fixture.PluginsTxtPath, GameRelease.Fallout4);

        Assert.Contains(session.Plugins, p =>
            string.Equals(p.Name, "Fallout4.esm", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void ImplicitPlugin_IsMarkedImmutable()
    {
        using var session = new GameSession(_fixture.DataFolder, _fixture.PluginsTxtPath, GameRelease.Fallout4);

        var fo4 = session.Plugins.Single(p =>
            string.Equals(p.Name, "Fallout4.esm", StringComparison.OrdinalIgnoreCase));

        Assert.True(fo4.IsImmutable);
    }

    [Fact]
    public void ImplicitPlugin_HasLowerLoadOrderIndex_ThanUserPlugin()
    {
        using var session = new GameSession(_fixture.DataFolder, _fixture.PluginsTxtPath, GameRelease.Fallout4);

        var fo4 = session.Plugins.Single(p =>
            string.Equals(p.Name, "Fallout4.esm", StringComparison.OrdinalIgnoreCase));
        var user = session.Plugins.Single(p =>
            string.Equals(p.Name, GameSessionImplicitFixture.UserPluginName, StringComparison.OrdinalIgnoreCase));

        Assert.True(fo4.LoadOrderIndex < user.LoadOrderIndex);
    }

    [Fact]
    public void UserPlugin_IsNotImmutable()
    {
        using var session = new GameSession(_fixture.DataFolder, _fixture.PluginsTxtPath, GameRelease.Fallout4);

        var user = session.Plugins.Single(p =>
            string.Equals(p.Name, GameSessionImplicitFixture.UserPluginName, StringComparison.OrdinalIgnoreCase));

        Assert.False(user.IsImmutable);
    }

    [Fact]
    public void ImplicitPlugin_AlreadyInPluginsTxt_IsNotDuplicated()
    {
        // Fallout4.esm is listed explicitly in Plugins.txt AND present on disk — should appear only once
        using var data = new PluginFixtureBuilder("medit-dedup")
            .WithPlugin("Fallout4.esm")
            .Build();

        using var session = new GameSession(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

        var count = session.Plugins.Count(p =>
            string.Equals(p.Name, "Fallout4.esm", StringComparison.OrdinalIgnoreCase));
        Assert.Equal(1, count);
    }

    [Fact]
    public void ImplicitPlugin_MissingFromDataFolder_IsNotLoaded()
    {
        // This fixture's data folder has Fallout4.esm but NOT DLCRobot.esm
        using var session = new GameSession(_fixture.DataFolder, _fixture.PluginsTxtPath, GameRelease.Fallout4);

        Assert.DoesNotContain(session.Plugins, p =>
            string.Equals(p.Name, "DLCRobot.esm", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void Constructor_ExposesGameRelease()
    {
        using var session = new GameSession(_fixture.DataFolder, _fixture.PluginsTxtPath, GameRelease.Fallout4);
        Assert.Equal(GameRelease.Fallout4, session.GameRelease);
    }
}
