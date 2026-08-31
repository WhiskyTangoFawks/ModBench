using MEditService.Core.Plugins;
using MEditService.Core.Records;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Plugins;

// ADR-0044: `LoadOrder` is the held set of plugin copies — resolved from a snapshot (forced masters
// first), opened one at a time, and mutated in place as copies arrive, leave, or move.
public sealed class LoadOrderTests
{
    private const string UserPlugin = "UserMod.esp";

    private static LoadOrder Open(PluginFixtureData data, IReadOnlyList<LoadOrderEntry>? entries = null, ILogger? logger = null)
    {
        var loadOrder = new LoadOrder(data.DataFolder, null, GameRelease.Fallout4, logger);
        foreach (var plugin in LoadOrder.Resolve(data.DataFolder, GameRelease.Fallout4, entries ?? data.Plugins))
            loadOrder.Open(plugin);
        return loadOrder;
    }

    // ── Resolve: forced masters and Creation Club content ───────────────────────

    [Fact]
    public void Resolve_ImplicitMaster_IsForcedFirst_AndSnapshotSlotsAreOffsetPastIt()
    {
        using var data = new PluginFixtureBuilder("lo-implicit")
            .WithPlugin("Fallout4.esm", listed: false)
            .WithPlugin(UserPlugin)
            .Build();

        var resolved = LoadOrder.Resolve(data.DataFolder, GameRelease.Fallout4, data.Plugins);

        var fo4 = resolved.Single(p => p.Name.Equals("Fallout4.esm", StringComparison.OrdinalIgnoreCase));
        var user = resolved.Single(p => p.Name == UserPlugin);
        Assert.True(fo4.IsForced);
        Assert.Equal(PluginOrigin.DataDirectory, fo4.Origin);
        Assert.True(fo4.Registration.Participates);
        Assert.False(user.IsForced);
        Assert.Equal(0, fo4.Registration.LoadOrderIndex);
        Assert.Equal(1, user.Registration.LoadOrderIndex);
    }

    [Fact]
    public void Resolve_ImplicitMasterAlsoInSnapshot_IsHeldOnce_ForcedOn()
    {
        using var data = new PluginFixtureBuilder("lo-dedup")
            .WithPlugin("Fallout4.esm")
            .Build();

        var resolved = LoadOrder.Resolve(data.DataFolder, GameRelease.Fallout4, data.Plugins);

        var fo4 = Assert.Single(resolved, p => p.Name.Equals("Fallout4.esm", StringComparison.OrdinalIgnoreCase));
        Assert.True(fo4.IsForced);
    }

    [Fact]
    public void Resolve_ImplicitMasterMissingFromDisk_IsNotResolved()
    {
        using var data = new PluginFixtureBuilder("lo-missing-implicit")
            .WithPlugin("Fallout4.esm", listed: false)
            .WithPlugin(UserPlugin)
            .Build();

        var resolved = LoadOrder.Resolve(data.DataFolder, GameRelease.Fallout4, data.Plugins);

        Assert.DoesNotContain(resolved, p => p.Name.Equals("DLCRobot.esm", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void Resolve_CreationClubOnlyPlugin_IsForcedAfterImplicitMastersAndBeforeTheSnapshot()
    {
        using var data = new PluginFixtureBuilder("lo-ccc")
            .WithPlugin("Fallout4.esm", listed: false)
            .WithPlugin("ccTest.esl", listed: false)
            .WithPlugin(UserPlugin)
            .WithCreationClubCatalog("ccTest.esl")
            .Build();

        var resolved = LoadOrder.Resolve(data.DataFolder, GameRelease.Fallout4, data.Plugins);

        var implicitMaster = resolved.Single(p => p.Name.Equals("Fallout4.esm", StringComparison.OrdinalIgnoreCase));
        var cc = resolved.Single(p => p.Name == "ccTest.esl");
        var user = resolved.Single(p => p.Name == UserPlugin);
        Assert.True(cc.IsForced);
        Assert.True(cc.Registration.Participates);
        Assert.Equal(PluginOrigin.DataDirectory, cc.Origin);
        Assert.True(implicitMaster.Registration.LoadOrderIndex < cc.Registration.LoadOrderIndex);
        Assert.True(cc.Registration.LoadOrderIndex < user.Registration.LoadOrderIndex);
    }

    [Fact]
    public void Resolve_CreationClubPluginAlsoInSnapshot_IsHeldOnce_ForcedOn()
    {
        using var data = new PluginFixtureBuilder("lo-ccc-dedup")
            .WithPlugin("ccDup.esl")
            .WithCreationClubCatalog("ccDup.esl")
            .Build();

        var resolved = LoadOrder.Resolve(data.DataFolder, GameRelease.Fallout4, data.Plugins);

        var cc = Assert.Single(resolved, p => p.Name == "ccDup.esl");
        Assert.True(cc.IsForced);
    }

    [Fact]
    public void Resolve_CreationClubCatalogOrder_IsPreservedRegardlessOfName()
    {
        using var data = new PluginFixtureBuilder("lo-ccc-order")
            .WithPlugin("ccZebra.esl", listed: false)
            .WithPlugin("ccAlpha.esl", listed: false)
            .WithCreationClubCatalog("ccZebra.esl", "ccAlpha.esl")
            .Build();

        var resolved = LoadOrder.Resolve(data.DataFolder, GameRelease.Fallout4, data.Plugins);

        var zebra = resolved.Single(p => p.Name == "ccZebra.esl");
        var alpha = resolved.Single(p => p.Name == "ccAlpha.esl");
        Assert.True(zebra.Registration.LoadOrderIndex < alpha.Registration.LoadOrderIndex);
    }

    [Fact]
    public void Resolve_SnapshotFacts_CarryThrough()
    {
        using var data = new PluginFixtureBuilder("lo-facts")
            .WithPlugin("A.esp")
            .Build();
        var entries = new List<LoadOrderEntry>
        {
            new("A.esp", Path.Combine(data.DataFolder, "A.esp"), "ModA", Slot: 3, Enabled: false, Winning: true),
            new("A.esp", Path.Combine(data.DataFolder, "A.esp"), "ModB", Slot: null, Enabled: true, Winning: false),
        };

        var resolved = LoadOrder.Resolve(data.DataFolder, GameRelease.Fallout4, entries);

        var a = resolved.Single(p => p.Origin == "ModA");
        var b = resolved.Single(p => p.Origin == "ModB");
        Assert.Equal(new Registration(3, Enabled: false, Winning: true), a.Registration);
        Assert.Equal(new Registration(null, Enabled: true, Winning: false), b.Registration);
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
        Assert.Contains(loadOrder.LoadFailures, f => f.Name == "NonExistent.esp");
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
        var failure = Assert.Single(loadOrder.LoadFailures);
        Assert.Equal("Bad.esp", failure.Name);
    }

    [Fact]
    public void Open_AfterAFailure_ClearsTheFailure()
    {
        using var data = new PluginFixtureBuilder("lo-recover")
            .WithPlugin("Fixed.esp")
            .Build();
        var loadOrder = new LoadOrder(data.DataFolder, null, GameRelease.Fallout4);
        using var _ = loadOrder;
        var resolved = LoadOrder.Resolve(data.DataFolder, GameRelease.Fallout4, data.Plugins).Single();
        var missing = resolved with { Path = Path.Combine(data.DataFolder, "Elsewhere.esp") };

        Assert.Null(loadOrder.Open(missing));
        Assert.Single(loadOrder.LoadFailures);

        Assert.NotNull(loadOrder.Open(resolved));
        Assert.Empty(loadOrder.LoadFailures);
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
    public void AddCreatedPlugin_IsParticipating_AtTheNextSlot_UnderTheCallersOrigin()
    {
        using var data = new PluginFixtureBuilder("lo-create").WithPlugin("Existing.esp").Build();
        using var loadOrder = Open(data);
        var newPath = Path.Combine(data.DataFolder, "New.esp");
        new Fallout4Mod(ModKey.FromFileName("New.esp"), Fallout4Release.Fallout4)
            .WriteToBinary(newPath);

        var created = loadOrder.AddCreatedPlugin(newPath, "MyMod");

        Assert.Equal("MyMod", created.Origin);
        Assert.True(created.Participates);
        Assert.False(created.IsImmutable);
        Assert.Equal(loadOrder.Plugins.Single(p => p.Name == "Existing.esp").LoadOrderIndex + 1, created.LoadOrderIndex);
        Assert.NotNull(loadOrder.GetMod("New.esp", "MyMod"));
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
