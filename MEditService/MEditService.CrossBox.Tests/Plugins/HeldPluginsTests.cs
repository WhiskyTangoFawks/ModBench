using MEditService.Http;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Plugins;

// ADR-0013: `HeldPlugins` is the held set of plugin copies — opened one at a time from the copies a
// snapshot registers, and mutated in place as copies arrive, leave, or move.
public sealed class HeldPluginsTests
{
    private const string UserPlugin = "UserMod.esp";

    private static HeldPlugins Open(PluginFixtureData data, IReadOnlyList<LoadOrderEntry>? entries = null, ILogger? logger = null)
    {
        var held = new HeldPlugins(MutagenPluginAdapter.Instance, data.DataFolder, null, GameRelease.Fallout4, logger);
        foreach (var plugin in ForcedPlugins.Prepend(data.DataFolder, GameRelease.Fallout4, entries ?? data.Plugins))
            held.Open(plugin);
        return held;
    }

    // ── Open ────────────────────────────────────────────────────────────────────

    [Fact]
    public void Open_ForcedMaster_IsForced_AndLoadsBeforeTheSnapshotPlugin()
    {
        using var data = new PluginFixtureBuilder("lo-open")
            .WithPlugin("Fallout4.esm", listed: false)
            .WithPlugin(UserPlugin)
            .Build();

        var held = Open(data);

        var fo4 = held.Plugins.Single(p => p.Name.Equals("Fallout4.esm", StringComparison.OrdinalIgnoreCase));
        var user = held.Plugins.Single(p => p.Name == UserPlugin);
        Assert.True(fo4.IsForced);
        Assert.False(user.IsForced);
        Assert.True(fo4.LoadOrderIndex < user.LoadOrderIndex);
        Assert.Equal(GameRelease.Fallout4, held.GameRelease);
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

        var held = Open(data, entries);

        Assert.Contains(held.Plugins, p => p.Name == "Present.esp");
        Assert.DoesNotContain(held.Plugins, p => p.Name == "NonExistent.esp");
        Assert.Contains(held.Failures, f => f.Name == "NonExistent.esp");
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

        var held = Open(data, entries);

        Assert.Contains(held.Plugins, p => p.Name == "Good.esp");
        Assert.DoesNotContain(held.Plugins, p => p.Name == "Bad.esp");
        var failure = Assert.Single(held.Failures);
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
        var held = new HeldPlugins(MutagenPluginAdapter.Instance, fx.GameDirectory, null, GameRelease.Fallout4);

        foreach (var plugin in ForcedPlugins.Prepend(fx.GameDirectory, GameRelease.Fallout4, [winner, loser]))
            held.Open(plugin);

        Assert.Equal("ModA", Assert.Single(held.Plugins).Origin);
        var failure = Assert.Single(held.Failures);
        Assert.Equal("Shared.esp", failure.Name);
        Assert.Equal("ModB", failure.Origin);
    }

    [Fact]
    public void Open_AfterAFailure_ClearsTheFailure()
    {
        using var data = new PluginFixtureBuilder("lo-recover")
            .WithPlugin("Fixed.esp")
            .Build();
        var held = new HeldPlugins(MutagenPluginAdapter.Instance, data.DataFolder, null, GameRelease.Fallout4);
        var resolved = ForcedPlugins.Prepend(data.DataFolder, GameRelease.Fallout4, data.Plugins).Single();
        var missing = resolved with { Path = Path.Combine(data.DataFolder, "Elsewhere.esp") };

        Assert.Null(held.Open(missing));
        Assert.Single(held.Failures);

        Assert.NotNull(held.Open(resolved));
        Assert.Empty(held.Failures);
    }

    [Theory]
    [InlineData("TestMod.esl", true, false)]
    [InlineData("UserMaster.esm", false, true)]
    [InlineData("UserPatch.esp", false, false)]
    public void Open_ExtensionFlags(string name, bool isLight, bool isMaster)
    {
        using var data = new PluginFixtureBuilder("lo-ext").WithPlugin(name).Build();
        var held = Open(data);

        var plugin = held.Plugins.Single(p => p.Name == name);
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
        var held = Open(data);

        Assert.True(held.Plugins.Single(p => p.Name == "EslFlagged.esp").IsLight);
        Assert.True(held.Plugins.Single(p => p.Name == "EsmFlagged.esp").IsMaster);
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
        var held = Open(data);

        Assert.Equal(3, held.Plugins.Single(p => p.Name == "WithRecords.esp").RecordCount);
    }

    [Fact]
    public void Find_IsCaseInsensitive_AndNullForAnUnknownCopy()
    {
        using var data = new PluginFixtureBuilder("lo-find").WithPlugin("CaseMod.esp").Build();
        var held = Open(data);

        Assert.NotNull(held.Find(new PluginCopyKey("CASEMOD.ESP", PluginOrigin.DataDirectory)));
        Assert.NotNull(held.Find(new PluginCopyKey("casemod.esp", PluginOrigin.DataDirectory)));
        Assert.Null(held.Find(new PluginCopyKey("Unknown.esp", PluginOrigin.DataDirectory)));
        Assert.Null(held.Find(new PluginCopyKey("CaseMod.esp", "SomeOtherOrigin")));
    }

    // ── Mutation in place ───────────────────────────────────────────────────────

    [Fact]
    public void Update_MovesTheRegistration_AndTheDerivedFactsFollow()
    {
        using var data = new PluginFixtureBuilder("lo-update").WithPlugin("A.esp").Build();
        var held = Open(data);
        var copy = held.Plugins.Single();
        Assert.True(copy.Participates);

        var updated = held.Update(copy, Registration.Disabled(0));

        Assert.False(updated.Participates);
        Assert.True(updated.InLoadOrder);
        Assert.False(held.Plugins.Single().Participates);

        var losing = held.Update(updated, Registration.Losing(0));
        Assert.False(losing.InLoadOrder);
    }

    [Fact]
    public void Remove_DropsTheCopy_AndWhatItAnswered()
    {
        using var data = new PluginFixtureBuilder("lo-remove").WithPlugin("A.esp").WithPlugin("B.esp").Build();
        var held = Open(data);
        var removed = new PluginCopyKey("A.esp", PluginOrigin.DataDirectory);

        Assert.True(held.Remove(removed));

        Assert.Equal(["B.esp"], held.Plugins.Select(p => p.Name));
        Assert.Null(held.Find(removed));
        Assert.DoesNotContain(removed, held.OpenedCopies.Keys);
        Assert.False(held.Remove(removed));
    }

    [Fact]
    public void Open_WithLogger_LogsToProvidedLogger()
    {
        using var data = new PluginFixtureBuilder("lo-logger").WithPlugin("LogTest.esp").Build();
        var logger = new CapturingLogger();

        var held = Open(data, logger: logger);

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
