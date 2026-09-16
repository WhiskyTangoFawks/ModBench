using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Tests.Plugins;

// ADR-0013: the held set of plugin copies, opened one at a time from the copies a snapshot
// registers, and mutated in place as copies arrive, leave, or move, as the reads and the status
// report it.
public sealed class HeldPluginsTests
{
    private const string UserPlugin = "UserMod.esp";

    private static IndexProjector Open(PluginFixtureData data, IReadOnlyList<LoadOrderEntry>? entries = null, ILoggerFactory? loggerFactory = null) =>
        Indexes.Reconciled(data.DataFolder, entries ?? data.Plugins, loggerFactory: loggerFactory);

    private static PluginCopyKey Key(string name, string origin = PluginOrigin.DataDirectory) => new(name, origin);

    // ── Open ────────────────────────────────────────────────────────────────────

    [Fact]
    public void Open_ForcedMaster_LoadsBeforeTheSnapshotPlugin()
    {
        using var data = new PluginFixtureBuilder("lo-open")
            .WithPlugin("Fallout4.esm", listed: false)
            .WithPlugin(UserPlugin)
            .Build();

        using var held = Open(data);

        Assert.Equal(["Fallout4.esm", UserPlugin], held.Status.IndexedPlugins.Select(p => p.Name));
        Assert.True(held.Registers(Key("Fallout4.esm")));
        Assert.True(held.Registers(Key(UserPlugin)));
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

        using var held = Open(data, entries);

        var opened = held.RequireReads().OpenedCopies.Keys;
        Assert.Contains(Key("Present.esp"), opened);
        Assert.DoesNotContain(Key("NonExistent.esp"), opened);
        Assert.Contains(held.Status.Failures, f => f.Name == "NonExistent.esp");
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

        using var held = Open(data, entries);

        var opened = held.RequireReads().OpenedCopies.Keys;
        Assert.Contains(Key("Good.esp"), opened);
        Assert.DoesNotContain(Key("Bad.esp"), opened);
        var failure = Assert.Single(held.Status.Failures);
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

        using var held = Indexes.Reconciled(fx.GameDirectory, [winner, loser]);

        Assert.Equal("ModA", Assert.Single(held.RequireReads().OpenedCopies.Keys).Origin);
        var failure = Assert.Single(held.Status.Failures);
        Assert.Equal("Shared.esp", failure.Name);
        Assert.Equal("ModB", failure.Origin);
    }

    [Fact]
    public void Open_AfterAFailure_ClearsTheFailure()
    {
        using var data = new PluginFixtureBuilder("lo-recover")
            .WithPlugin("Fixed.esp")
            .Build();
        var resolved = data.Plugins.Single();
        var missing = resolved with { Path = Path.Combine(data.DataFolder, "Elsewhere.esp") };
        var holder = new LoadOrderHolder();
        using var held = Indexes.Open(holder);

        held.Reconcile(holder, data.DataFolder, [missing], GameRelease.Fallout4);
        Assert.Single(held.Status.Failures);

        held.Reconcile(holder, data.DataFolder, [resolved], GameRelease.Fallout4);
        Assert.Empty(held.Status.Failures);
        Assert.Contains(Key("Fixed.esp"), held.RequireReads().OpenedCopies.Keys);
    }

    [Theory]
    [InlineData("TestMod.esl", true, false)]
    [InlineData("UserMaster.esm", false, true)]
    [InlineData("UserPatch.esp", false, false)]
    public void Open_ExtensionFlags(string name, bool isLight, bool isMaster)
    {
        using var data = new PluginFixtureBuilder("lo-ext").WithPlugin(name).Build();
        using var held = Open(data);

        var content = held.RequireReads().OpenedCopies[Key(name)];
        Assert.Equal(isLight, content.IsLight);
        Assert.Equal(isMaster, content.IsMaster);
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
        using var held = Open(data);

        var opened = held.RequireReads().OpenedCopies;
        Assert.True(opened[Key("EslFlagged.esp")].IsLight);
        Assert.True(opened[Key("EsmFlagged.esp")].IsMaster);
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
        using var held = Open(data);

        Assert.Equal(3, held.RequireReads().OpenedCopies[Key("WithRecords.esp")].RecordCount);
    }

    [Fact]
    public void Registers_TheHeldCopy_AndFalseForAnUnknownCopyOrOrigin()
    {
        using var data = new PluginFixtureBuilder("lo-find").WithPlugin("CaseMod.esp").Build();
        using var held = Open(data);

        Assert.True(held.Registers(Key("CaseMod.esp")));
        Assert.False(held.Registers(Key("Unknown.esp")));
        Assert.False(held.Registers(Key("CaseMod.esp", "SomeOtherOrigin")));
    }

    // ── Mutation in place ───────────────────────────────────────────────────────

    [Fact]
    public void Update_MovesTheRegistration_AndTheDerivedFactsFollow()
    {
        using var data = new PluginFixtureBuilder("lo-update").WithPlugin("A.esp", mod => mod.Npcs.AddNew("Npc")).Build();
        var holder = new LoadOrderHolder();
        using var held = Indexes.Open(holder);
        held.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4);
        var npc = held.RequireReads().Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 10)).Items.Single().FormKey;
        Assert.True(held.RequireReads().GetDocument(npc, Key("A.esp"))?.IsWinner);

        held.Reconcile(holder, data.DataFolder, [data.Plugins.Single() with { Enabled = false }], GameRelease.Fallout4);

        Assert.True(held.Registers(Key("A.esp")));
        Assert.False(held.RequireReads().GetDocument(npc, Key("A.esp"))?.IsWinner);
        Assert.Contains(Key("A.esp"), held.RequireReads().OpenedCopies.Keys);
    }

    [Fact]
    public void Remove_DropsTheCopy_AndWhatItAnswered()
    {
        using var data = new PluginFixtureBuilder("lo-remove").WithPlugin("A.esp").WithPlugin("B.esp").Build();
        var holder = new LoadOrderHolder();
        using var held = Indexes.Open(holder);
        held.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4);
        var removed = Key("A.esp");

        held.Reconcile(holder, data.DataFolder, [.. data.Plugins.Where(p => p.Name == "B.esp")], GameRelease.Fallout4);

        Assert.Equal(["B.esp"], held.Status.IndexedPlugins.Select(p => p.Name));
        Assert.False(held.Registers(removed));
        Assert.DoesNotContain(removed, held.RequireReads().OpenedCopies.Keys);
    }

    [Fact]
    public void Open_WithLogger_LogsToProvidedLogger()
    {
        using var data = new PluginFixtureBuilder("lo-logger").WithPlugin("LogTest.esp").Build();
        var entries = new List<LogEntry>();
        using var loggerFactory = LoggerFactory.Create(b =>
        {
            b.SetMinimumLevel(LogLevel.Debug);
            b.AddProvider(new CollectingLoggerProvider(entries));
        });

        using var held = Open(data, loggerFactory: loggerFactory);

        Assert.Contains(entries, e => e.Message.Contains("LogTest.esp", StringComparison.Ordinal));
    }
}
