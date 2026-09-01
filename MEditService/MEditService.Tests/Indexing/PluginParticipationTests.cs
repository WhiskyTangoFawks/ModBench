using MEditService.Core.Records;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Indexing;

// ADR-0035: UpdateWinners() and form_lookup's own winner sweep carry a participation
// predicate — an indexed-but-non-participating plugin's row can never be a winner, regardless of
// its load_order_idx.
public class PluginParticipationTests
{
    private static readonly SchemaReflector Reflector = SharedSchemaReflector.Instance;
    private static readonly TableDdlBuilder Ddl = new TableDdlBuilder(Reflector);

    private static DuckDbRecordIndex OpenRepo()
    {
        var repo = new DuckDbRecordIndex(Reflector, Ddl, NullLogger.Instance);
        repo.Initialize(GameRelease.Fallout4);
        return repo;
    }

    // PluginA.esm defines SharedNPC; PluginB.esp overrides it. Deterministic FormID assignment
    // means npcKey is identical across independently-built fixtures, so two repos built from two
    // calls to this helper can be compared directly by (plugin -> IsWinner).
    private static (PluginFixtureData Fixture, IModGetter ModA, Fallout4Mod ModB, FormKey NpcKey) BuildSharedNpcFixture(string prefix)
    {
        var fixture = new PluginFixtureBuilder(prefix)
            .WithPlugin("PluginA.esm", mod => mod.Npcs.AddNew("SharedNPC"))
            .Build();

        var modA = (IModGetter)Fallout4Mod.CreateFromBinaryOverlay(
            new ModPath(ModKey.FromFileName("PluginA.esm"), Path.Combine(fixture.DataFolder, "PluginA.esm")),
            Fallout4Release.Fallout4);
        var npcKey = modA.EnumerateMajorRecords<INpcGetter>().First().FormKey;

        var modB = new Fallout4Mod(ModKey.FromFileName("PluginB.esp"), Fallout4Release.Fallout4);
        modB.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("PluginA.esm") });
        modB.Npcs.Set(modA.EnumerateMajorRecords<INpcGetter>().First().DeepCopy());

        return (fixture, modA, modB, npcKey);
    }

    private static Dictionary<string, bool> WinnersByPlugin(DuckDbRecordIndex repo, string npcKey) =>
        repo.At(RecordRef.Effective).GetOverrideStack(npcKey)?.Entries.ToDictionary(o => o.Plugin.Name, o => o.IsWinner) ?? [];

    [Fact]
    public void DisabledPlugin_LaterInLoadOrder_DoesNotDisplaceEnabledWinner()
    {
        var (fixture, modA, modB, npcKey) = BuildSharedNpcFixture("participation-winner");
        using var _ = fixture;

        using var repo = OpenRepo();
        // PluginB sits last in the load order (highest load_order_idx) but is disabled — a bare
        // MAX(load_order_idx) sweep would incorrectly make it the winner.
        repo.Index(modA, Registration.Participating(0), new PluginKey(modA.ModKey.FileName.ToString(), "Data"));
        repo.Index(modB, Registration.Disabled(1), new PluginKey(modB.ModKey.FileName.ToString(), "Data"));
        repo.UpdateWinners();

        var overrides = repo.At(RecordRef.Effective).GetOverrideStack(npcKey.ToString())!.Entries;

        Assert.Equal(2, overrides.Count);
        var pluginA = overrides.Single(o => o.Plugin.Name == "PluginA.esm");
        var pluginB = overrides.Single(o => o.Plugin.Name == "PluginB.esp");
        Assert.True(pluginA.IsWinner);
        Assert.False(pluginB.IsWinner);
    }

    [Fact]
    public void SetPluginParticipation_FlipToDisabled_MatchesLoadingDisabledFromStart()
    {
        var (fixtureX, modAX, modBX, npcKeyX) = BuildSharedNpcFixture("participation-flip-x");
        using var _x = fixtureX;
        var (fixtureY, modAY, modBY, npcKeyY) = BuildSharedNpcFixture("participation-flip-y");
        using var _y = fixtureY;

        using var repoFlipped = OpenRepo();
        repoFlipped.Index(modAX, Registration.Participating(0), new PluginKey(modAX.ModKey.FileName.ToString(), "Data"));
        repoFlipped.Index(modBX, Registration.Participating(1), new PluginKey(modBX.ModKey.FileName.ToString(), "Data"));
        repoFlipped.UpdateWinners();
        repoFlipped.Register(new PluginKey("PluginB.esp", "Data"), Registration.Disabled(1));
        repoFlipped.UpdateWinners();

        using var repoFromStart = OpenRepo();
        repoFromStart.Index(modAY, Registration.Participating(0), new PluginKey(modAY.ModKey.FileName.ToString(), "Data"));
        repoFromStart.Index(modBY, Registration.Disabled(1), new PluginKey(modBY.ModKey.FileName.ToString(), "Data"));
        repoFromStart.UpdateWinners();

        var flipped = WinnersByPlugin(repoFlipped, npcKeyX.ToString());
        var fromStart = WinnersByPlugin(repoFromStart, npcKeyY.ToString());

        Assert.Equal(fromStart, flipped);
        Assert.False(flipped["PluginB.esp"]);
        Assert.True(flipped["PluginA.esm"]);
    }

    [Fact]
    public void SetPluginParticipation_FlippedTwice_IsIdempotent()
    {
        var (fixture, modA, modB, npcKey) = BuildSharedNpcFixture("participation-idempotent");
        using var _ = fixture;

        using var repo = OpenRepo();
        repo.Index(modA, Registration.Participating(0), new PluginKey(modA.ModKey.FileName.ToString(), "Data"));
        repo.Index(modB, Registration.Participating(1), new PluginKey(modB.ModKey.FileName.ToString(), "Data"));
        repo.UpdateWinners();

        repo.Register(new PluginKey("PluginB.esp", "Data"), Registration.Disabled(1));
        repo.UpdateWinners();
        var afterFirstFlip = WinnersByPlugin(repo, npcKey.ToString());

        repo.Register(new PluginKey("PluginB.esp", "Data"), Registration.Disabled(1));
        repo.UpdateWinners();
        var afterSecondFlip = WinnersByPlugin(repo, npcKey.ToString());

        Assert.Equal(afterFirstFlip, afterSecondFlip);
    }

    [Fact]
    public void DisabledOnlyFormKey_HasNoWinner()
    {
        using var fixture = new PluginFixtureBuilder("participation-lone")
            .WithPlugin("Disabled.esp", mod => mod.Npcs.AddNew("OnlyInDisabled"))
            .Build();

        var mod = (IModGetter)Fallout4Mod.CreateFromBinaryOverlay(
            new ModPath(ModKey.FromFileName("Disabled.esp"), Path.Combine(fixture.DataFolder, "Disabled.esp")),
            Fallout4Release.Fallout4);
        var npcKey = mod.EnumerateMajorRecords<INpcGetter>().First().FormKey;

        using var repo = OpenRepo();
        repo.Index(mod, Registration.Disabled(0), new PluginKey(mod.ModKey.FileName.ToString(), "Data"));
        repo.UpdateWinners();

        var record = repo.At(RecordRef.Effective).GetDocument(npcKey.ToString(), new PluginKey("Disabled.esp", "Data"));

        Assert.NotNull(record);
        Assert.False(record.IsWinner);
    }

    [Fact]
    public void DisabledOnlyFormKey_DoesNotResolveViaFormLookup()
    {
        using var fixture = new PluginFixtureBuilder("participation-lookup")
            .WithPlugin("Disabled.esp", mod => mod.Npcs.AddNew("OnlyInDisabled"))
            .Build();

        var mod = (IModGetter)Fallout4Mod.CreateFromBinaryOverlay(
            new ModPath(ModKey.FromFileName("Disabled.esp"), Path.Combine(fixture.DataFolder, "Disabled.esp")),
            Fallout4Release.Fallout4);
        var npcKey = mod.EnumerateMajorRecords<INpcGetter>().First().FormKey;

        using var repo = OpenRepo();
        repo.Index(mod, Registration.Disabled(0), new PluginKey(mod.ModKey.FileName.ToString(), "Data"));
        repo.UpdateWinners();

        Assert.Null(repo.At(RecordRef.Effective).Resolve(npcKey.ToString()));
    }
}
