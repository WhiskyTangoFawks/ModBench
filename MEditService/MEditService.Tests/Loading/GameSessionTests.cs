using MEditService.Core.Session;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

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

public sealed class GameSessionTests(GameSessionImplicitFixture fixture) : IClassFixture<GameSessionImplicitFixture>
{
    private readonly GameSessionImplicitFixture _fixture = fixture;

    [Fact]
    public void LoadSession_ImplicitPlugin_LoadedImmutableAndOrdered()
    {
        using var session = new GameSession(_fixture.DataFolder, _fixture.PluginsTxtPath, GameRelease.Fallout4);

        var fo4 = session.Plugins.Single(p =>
            string.Equals(p.Name, "Fallout4.esm", StringComparison.OrdinalIgnoreCase));
        var user = session.Plugins.Single(p =>
            string.Equals(p.Name, GameSessionImplicitFixture.UserPluginName, StringComparison.OrdinalIgnoreCase));

        Assert.NotNull(fo4);
        Assert.True(fo4.IsImmutable);
        Assert.False(user.IsImmutable);
        Assert.True(fo4.LoadOrderIndex < user.LoadOrderIndex);
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

// Tests that build their own plugin fixtures inline rather than relying on GameSessionImplicitFixture.
public sealed class GameSessionPluginMetadataTests
{
    // ── Extension flags ────────────────────────────────────────────────────────

    [Fact]
    public void Plugin_EslExtension_HasIsLightTrue_IsMasterFalse()
    {
        using var data = new PluginFixtureBuilder("gs-esl")
            .WithPlugin("TestMod.esl")
            .Build();
        using var session = new GameSession(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

        var plugin = session.Plugins.Single(p => p.Name == "TestMod.esl");
        Assert.True(plugin.IsLight);
        Assert.False(plugin.IsMaster);
    }

    [Fact]
    public void Plugin_EsmExtension_HasIsMasterTrue_IsLightFalse()
    {
        using var data = new PluginFixtureBuilder("gs-esm")
            .WithPlugin("UserMaster.esm")
            .Build();
        using var session = new GameSession(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

        var plugin = session.Plugins.Single(p => p.Name == "UserMaster.esm");
        Assert.True(plugin.IsMaster);
        Assert.False(plugin.IsLight);
    }

    [Fact]
    public void Plugin_EspExtension_HasBothFlagsfalse()
    {
        using var data = new PluginFixtureBuilder("gs-esp")
            .WithPlugin("UserPatch.esp")
            .Build();
        using var session = new GameSession(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

        var plugin = session.Plugins.Single(p => p.Name == "UserPatch.esp");
        Assert.False(plugin.IsLight);
        Assert.False(plugin.IsMaster);
    }

    // ── RecordCount ────────────────────────────────────────────────────────────

    [Fact]
    public void Plugin_RecordCount_MatchesActualRecordsInPlugin()
    {
        using var data = new PluginFixtureBuilder("gs-rcount")
            .WithPlugin("WithRecords.esp", mod =>
            {
                mod.Npcs.AddNew("Npc1");
                mod.Npcs.AddNew("Npc2");
                mod.Npcs.AddNew("Npc3");
            })
            .Build();
        using var session = new GameSession(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

        var plugin = session.Plugins.Single(p => p.Name == "WithRecords.esp");
        Assert.Equal(3, plugin.RecordCount);
    }

    // ── GetMod ─────────────────────────────────────────────────────────────────

    [Fact]
    public void GetMod_CaseInsensitive_ReturnsMod()
    {
        using var data = new PluginFixtureBuilder("gs-case")
            .WithPlugin("CaseMod.esp")
            .Build();
        using var session = new GameSession(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

        Assert.NotNull(session.GetMod("CASEMOD.ESP"));
        Assert.NotNull(session.GetMod("casemod.esp"));
        Assert.NotNull(session.GetMod("CaseMod.esp"));
    }

    [Fact]
    public void GetMod_UnknownName_ReturnsNull()
    {
        using var data = new PluginFixtureBuilder("gs-getmod-null")
            .WithPlugin("Known.esp")
            .Build();
        using var session = new GameSession(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

        Assert.Null(session.GetMod("Unknown.esp"));
    }

    // ── Dispose ────────────────────────────────────────────────────────────────

    [Fact]
    public void ListedPlugin_NotOnDisk_SessionLoadsSuccessfullyWithoutIt()
    {
        using var data = new PluginFixtureBuilder("gs-missing-listed")
            .WithPlugin("Present.esp")
            .Build();
        File.AppendAllText(data.PluginsTxtPath, "*NonExistent.esp\n");

        using var session = new GameSession(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

        Assert.Contains(session.Plugins, p => p.Name == "Present.esp");
        Assert.DoesNotContain(session.Plugins, p => p.Name == "NonExistent.esp");
    }

    [Fact]
    public void LoadedPlugin_FormKeyIsResolvableViaLinkCache()
    {
        FormKey npcKey = default;
        using var data = new PluginFixtureBuilder("gs-linkcache")
            .WithPlugin("WithNpc.esp", mod => npcKey = mod.Npcs.AddNew("TestNpc").FormKey)
            .Build();

        using var session = new GameSession(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

        Assert.True(session.LinkCache.TryResolve<IMajorRecordGetter>(npcKey, out _));
    }

    [Fact]
    public void Dispose_CalledTwice_DoesNotThrow()
    {
        using var data = new PluginFixtureBuilder("gs-dispose")
            .WithPlugin("DisposeTest.esp")
            .Build();
        var session = new GameSession(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
        session.Dispose();

        var ex = Record.Exception(() => session.Dispose());
        Assert.Null(ex);
    }

    [Fact]
    public void Constructor_WithLogger_LogsToProvidedLogger()
    {
        using var data = new PluginFixtureBuilder("gs-logger")
            .WithPlugin("LogTest.esp")
            .Build();
        var logger = new CapturingLogger();

        using var session = new GameSession(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4, logger);

        Assert.True(logger.WasCalled);
    }

    private sealed class CapturingLogger : ILogger
    {
        public bool WasCalled { get; private set; }
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => true;
        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
            => WasCalled = true;
    }
}
