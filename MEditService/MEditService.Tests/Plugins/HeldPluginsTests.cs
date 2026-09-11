using MEditService.Api;
using MEditService.Core.PluginAdapter;
using MEditService.Core.Plugins;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Plugins;

// ADR-0044: `HeldPlugins` is the held set of plugin copies — opened one at a time from the copies a
// snapshot registers, and mutated in place as copies arrive, leave, or move.
public sealed class HeldPluginsTests
{
    private const string UserPlugin = "UserMod.esp";

    private static HeldPlugins Open(PluginFixtureData data, IReadOnlyList<LoadOrderEntry>? entries = null, ILogger? logger = null)
    {
        var loadOrder = new HeldPlugins(MutagenPluginAdapter.Instance, data.DataFolder, null, GameRelease.Fallout4, logger);
        foreach (var plugin in ForcedPlugins.Prepend(data.DataFolder, GameRelease.Fallout4, entries ?? data.Plugins))
            loadOrder.Open(plugin);
        return loadOrder;
    }

    // ── Open ────────────────────────────────────────────────────────────────────

    [Fact]
    public void Open_ForcedMaster_IsImmutable_AndSnapshotPlugin_IsNot()
    {
        using var data = new PluginFixtureBuilder("lo-open")
            .WithPlugin("Fallout4.esm", listed: false)
            .WithPlugin(UserPlugin)
            .Build();

        using var loadOrder = Open(data);

        var fo4 = loadOrder.Plugins.Single(p => p.Name.Equals("Fallout4.esm", StringComparison.OrdinalIgnoreCase));
        var user = loadOrder.Plugins.Single(p => p.Name == UserPlugin);
        Assert.True(fo4.IsImmutable);
        Assert.False(user.IsImmutable);
        Assert.True(fo4.LoadOrderIndex < user.LoadOrderIndex);
        Assert.Equal(GameRelease.Fallout4, loadOrder.GameRelease);
    }

    [Fact]
    public void Open_MissingFile_IsAFailureOnTheRow_NotAnException()
    {
        using var data = new PluginFixtureBuilder("lo-missing")
            .WithPlugin("Present.esp")
            .Build();
        var entries = data.Plugins.Append(new LoadOrderEntry(
            "NonExistent.esp", Path.Combine(data.DataFolder, "NonExistent.esp"),
            PluginOrigin.DataDirectory, Slot: 1, Enabled: true, Winning: true)).ToList();

        using var loadOrder = Open(data, entries);

        Assert.Contains(loadOrder.Plugins, p => p.Name == "Present.esp");
        Assert.DoesNotContain(loadOrder.Plugins, p => p.Name == "NonExistent.esp");
        Assert.Contains(loadOrder.Failures, f => f.Name == "NonExistent.esp");
    }

    [Fact]
    public void Open_UnparseableFile_IsAFailureOnTheRow_RestStillOpen()
    {
        using var data = new PluginFixtureBuilder("lo-garbage")
            .WithPlugin("Good.esp")
            .Build();
        var badPath = Path.Combine(data.DataFolder, "Bad.esp");
        File.WriteAllBytes(badPath, [0xDE, 0xAD, 0xBE, 0xEF]);
        var entries = data.Plugins.Append(new LoadOrderEntry(
            "Bad.esp", badPath, PluginOrigin.DataDirectory, Slot: 1, Enabled: true, Winning: true)).ToList();

        using var loadOrder = Open(data, entries);

        Assert.Contains(loadOrder.Plugins, p => p.Name == "Good.esp");
        Assert.DoesNotContain(loadOrder.Plugins, p => p.Name == "Bad.esp");
        var failure = Assert.Single(loadOrder.Failures);
        Assert.Equal("Bad.esp", failure.Name);
    }

    [Fact]
    public void Open_LosingCopyUnparseable_TheFailureNamesTheLosingOrigin()
    {
        using var fx = new PluginFixtureBuilder("lo-losing-garbage")
            .WithPlugin("Shared.esp", origin: "ModA")
            .WithPlugin("Shared.esp", origin: "ModB")
            .BuildScattered();
        var winner = fx.Plugins.Single(p => p.Origin == "ModA");
        var loser = fx.Plugins.Single(p => p.Origin == "ModB") with { Slot = winner.Slot, Winning = false };
        File.WriteAllBytes(loser.Path, [0xDE, 0xAD, 0xBE, 0xEF]);
        using var loadOrder = new HeldPlugins(MutagenPluginAdapter.Instance, fx.GameDirectory, null, GameRelease.Fallout4);

        foreach (var plugin in ForcedPlugins.Prepend(fx.GameDirectory, GameRelease.Fallout4, [winner, loser]))
            loadOrder.Open(plugin);

        Assert.Equal("ModA", Assert.Single(loadOrder.Plugins).Origin);
        var failure = Assert.Single(loadOrder.Failures);
        Assert.Equal("Shared.esp", failure.Name);
        Assert.Equal("ModB", failure.Origin);
    }

    [Fact]
    public void Open_AfterAFailure_ClearsTheFailure()
    {
        using var data = new PluginFixtureBuilder("lo-recover")
            .WithPlugin("Fixed.esp")
            .Build();
        var loadOrder = new HeldPlugins(MutagenPluginAdapter.Instance, data.DataFolder, null, GameRelease.Fallout4);
        using var _ = loadOrder;
        var resolved = ForcedPlugins.Prepend(data.DataFolder, GameRelease.Fallout4, data.Plugins).Single();
        var missing = resolved with { Path = Path.Combine(data.DataFolder, "Elsewhere.esp") };

        Assert.Null(loadOrder.Open(missing));
        Assert.Single(loadOrder.Failures);

        Assert.NotNull(loadOrder.Open(resolved));
        Assert.Empty(loadOrder.Failures);
    }

    [Theory]
    [InlineData("TestMod.esl", true, false)]
    [InlineData("UserMaster.esm", false, true)]
    [InlineData("UserPatch.esp", false, false)]
    public void Open_ExtensionFlags(string name, bool isLight, bool isMaster)
    {
        using var data = new PluginFixtureBuilder("lo-ext").WithPlugin(name).Build();
        using var loadOrder = Open(data);

        var plugin = loadOrder.Plugins.Single(p => p.Name == name);
        Assert.Equal(isLight, plugin.IsLight);
        Assert.Equal(isMaster, plugin.IsMaster);
    }

    // The overwhelmingly common light/master plugin in the wild is a header-flagged .esp, not
    // a distinct extension — engine-authoritative light/master must follow the header flag.
    [Fact]
    public void Open_HeaderFlaggedEsp_FollowsTheHeaderFlag()
    {
        using var data = new PluginFixtureBuilder("lo-flags")
            .WithPlugin("EslFlagged.esp", mod => mod.IsSmallMaster = true)
            .WithPlugin("EsmFlagged.esp", mod => mod.IsMaster = true)
            .Build();
        using var loadOrder = Open(data);

        Assert.True(loadOrder.Plugins.Single(p => p.Name == "EslFlagged.esp").IsLight);
        Assert.True(loadOrder.Plugins.Single(p => p.Name == "EsmFlagged.esp").IsMaster);
    }

    [Fact]
    public void Open_RecordCount_MatchesTheFile()
    {
        using var data = new PluginFixtureBuilder("lo-rcount")
            .WithPlugin("WithRecords.esp", mod =>
            {
                mod.Npcs.AddNew("Npc1");
                mod.Npcs.AddNew("Npc2");
                mod.Npcs.AddNew("Npc3");
            })
            .Build();
        using var loadOrder = Open(data);

        Assert.Equal(3, loadOrder.Plugins.Single(p => p.Name == "WithRecords.esp").RecordCount);
    }

    [Fact]
    public void GetMod_IsCaseInsensitive_AndNullForAnUnknownCopy()
    {
        using var data = new PluginFixtureBuilder("lo-getmod").WithPlugin("CaseMod.esp").Build();
        using var loadOrder = Open(data);

        Assert.NotNull(loadOrder.GetMod("CASEMOD.ESP", PluginOrigin.DataDirectory));
        Assert.NotNull(loadOrder.GetMod("casemod.esp", PluginOrigin.DataDirectory));
        Assert.Null(loadOrder.GetMod("Unknown.esp", PluginOrigin.DataDirectory));
        Assert.Null(loadOrder.GetMod("CaseMod.esp", "SomeOtherOrigin"));
    }

    // ── Mutation in place ───────────────────────────────────────────────────────

    [Fact]
    public void Update_MovesTheRegistration_AndTheDerivedFactsFollow()
    {
        using var data = new PluginFixtureBuilder("lo-update").WithPlugin("A.esp").Build();
        using var loadOrder = Open(data);
        var held = loadOrder.Plugins.Single();
        Assert.True(held.Participates);

        var updated = loadOrder.Update(held, Registration.Disabled(0));

        Assert.False(updated.Participates);
        Assert.True(updated.InLoadOrder);
        Assert.False(updated.IsImmutable);
        Assert.False(loadOrder.Plugins.Single().Participates);

        var losing = loadOrder.Update(updated, Registration.Losing(0));
        Assert.False(losing.InLoadOrder);
        Assert.True(losing.IsImmutable);
    }

    [Fact]
    public void Remove_DropsTheCopy_AndItsOverlay()
    {
        using var data = new PluginFixtureBuilder("lo-remove").WithPlugin("A.esp").WithPlugin("B.esp").Build();
        using var loadOrder = Open(data);

        Assert.True(loadOrder.Remove(new PluginKey("A.esp", PluginOrigin.DataDirectory)));

        Assert.Equal(["B.esp"], loadOrder.Plugins.Select(p => p.Name));
        Assert.Null(loadOrder.GetMod("A.esp", PluginOrigin.DataDirectory));
        Assert.False(loadOrder.Remove(new PluginKey("A.esp", PluginOrigin.DataDirectory)));
    }

    [Fact]
    public void Dispose_CalledTwice_DoesNotThrow()
    {
        using var data = new PluginFixtureBuilder("lo-dispose").WithPlugin("DisposeTest.esp").Build();
        var loadOrder = Open(data);
        loadOrder.Dispose();

        Assert.Null(Record.Exception(() => loadOrder.Dispose()));
    }

    [Fact]
    public void Open_WithLogger_LogsToProvidedLogger()
    {
        using var data = new PluginFixtureBuilder("lo-logger").WithPlugin("LogTest.esp").Build();
        var logger = new CapturingLogger();

        using var loadOrder = Open(data, logger: logger);

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
