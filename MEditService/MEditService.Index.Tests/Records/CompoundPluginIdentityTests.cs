using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.Index.Tests.Records;

public class CompoundPluginIdentityTests
{
    private readonly LoadOrderHolder _holder = new();

    private IRecordReads ReadsWithWinner(OpenedIndex index, ScatteredFixtureData fixture, PluginAddress winner) =>
        index.ReadsWithWinner(_holder, fixture.GameDirectory, fixture.Plugins, winner.Origin);

    private static readonly PluginAddress ModA = new("Shared.esp", "ModA");
    private static readonly PluginAddress ModB = new("Shared.esp", "ModB");

    private static ScatteredFixtureData SharedFilenameFixtureWhereDeterministicFormIdAssignmentGivesBothModsTheSameNpcFormKey(string prefix, out FormKey npcKey, bool modBEnabled = true, int modBSlot = 1)
    {
        FormKey key = default;
        var fixture = new PluginFixtureBuilder(prefix)
            .WithPlugin("Shared.esp", mod => mod.Npcs.AddNew("FromModB"), origin: "ModB", enabled: modBEnabled)
            .WithPlugin("Shared.esp", mod => key = mod.Npcs.AddNew("FromModA").FormKey, origin: "ModA")
            .BuildScattered();
        npcKey = key;
        fixture.Plugins = [.. fixture.Plugins.Select(p => p.Origin == "ModB" ? p with { Slot = modBSlot } : p)];
        return fixture;
    }

    [Fact]
    public void TwoOrigins_SameFilenameSameFormKey_IndexBothWithoutCollidingOnDelete()
    {
        using var fixture = SharedFilenameFixtureWhereDeterministicFormIdAssignmentGivesBothModsTheSameNpcFormKey("identity-both", out var npcKey);
        using var index = Indexes.Open(_holder);

        string? EditorIdWhileWinning(PluginAddress winner) => Assert.Single(
            ReadsWithWinner(index, fixture, winner).GetOverrideStack(npcKey.ToString())?.Entries ?? []).Effective.EditorId;

        Assert.Equal("FromModA", EditorIdWhileWinning(ModA));
        Assert.Equal("FromModB", EditorIdWhileWinning(ModB));
    }

    [Fact]
    public void TwoOrigins_SameFilenameSameFormKey_GetRecord_ScopesToRequestedOrigin()
    {
        using var fixture = SharedFilenameFixtureWhereDeterministicFormIdAssignmentGivesBothModsTheSameNpcFormKey("identity-get", out var npcKey);
        using var index = Indexes.Reconciled(fixture);

        var record = index.RequireReads().GetDocument(npcKey.ToString(), ModA);

        Assert.NotNull(record);
        Assert.Equal("FromModA", record.EditorId);
        Assert.Equal("ModA", record.Plugin.Origin);
    }

    [Fact]
    public void TwoOrigins_SameFilenameSameFormKey_CountRecordsForPlugin_CountsRequestedOriginOnly()
    {
        using var fixture = SharedFilenameFixtureWhereDeterministicFormIdAssignmentGivesBothModsTheSameNpcFormKey("identity-count", out _);
        using var index = Indexes.Open(_holder);
        var reads = ReadsWithWinner(index, fixture, ModA);

        Assert.Equal(1, reads.CountOf(ModA, "npc_"));
        Assert.Equal(0, reads.CountOf(ModB, "npc_"));
    }

    [Fact]
    public void TwoOrigins_SameFilenameSameFormKey_GetRecords_FiltersToRequestedOriginAndSurfacesIt()
    {
        using var fixture = SharedFilenameFixtureWhereDeterministicFormIdAssignmentGivesBothModsTheSameNpcFormKey("identity-list", out var npcKey);
        using var index = Indexes.Reconciled(fixture);

        var modAResult = index.RequireReads().Search(new RecordQuery(RecordTypes: ["npc_"], Plugin: "Shared.esp", Origin: "ModA", Limit: 100, Offset: 0));

        var item = Assert.Single(modAResult.Items);
        Assert.Equal(npcKey.ToString(), item.FormKey);
        Assert.Equal("FromModA", item.EditorId);
        Assert.Equal("ModA", item.Origin);
    }

    [Fact]
    public void TwoOrigins_SameFilenameSameFormKey_NonParticipatingOriginNeverWinsViaOtherOriginsParticipation()
    {
        const int modBSlotLaterThanModAWhereAFilenameOnlyJoinWouldPickIt = 5;
        using var fixture = SharedFilenameFixtureWhereDeterministicFormIdAssignmentGivesBothModsTheSameNpcFormKey(
            "identity-winner", out var npcKey, modBEnabled: false, modBSlot: modBSlotLaterThanModAWhereAFilenameOnlyJoinWouldPickIt);
        using var index = Indexes.Reconciled(fixture);

        var only = Assert.Single(index.RequireReads().GetOverrideStack(npcKey.ToString())?.Entries ?? []);

        Assert.Equal("FromModA", only.Effective.EditorId);
        Assert.True(only.IsWinner);
    }

    private static void PopulateStructuralInTheSameBuildOrderSoCorrespondingRecordsLandOnIdenticalFormKeys(Fallout4Mod mod, string suffix, out FormKey cellKey, out FormKey placedKey, out FormKey npcKey, out FormKey raceKey)
    {
        var wrld = mod.Worldspaces.AddNew($"World{suffix}");
        var cell = new Cell(mod) { EditorID = $"Cell{suffix}", Grid = new CellGrid { Point = new P2Int(0, 0) } };
        var placed = new PlacedObject(mod) { EditorID = $"Placed{suffix}", Position = new P3Float(1f, 2f, 3f) };
        cell.Persistent.Add(placed);
        var sub = new WorldspaceSubBlock { BlockNumberX = 0, BlockNumberY = 0 };
        sub.Items.Add(cell);
        var block = new WorldspaceBlock { BlockNumberX = 0, BlockNumberY = 0 };
        block.Items.Add(sub);
        wrld.SubCells.Add(block);

        var race = mod.Races.AddNew($"Race{suffix}");
        var npc = mod.Npcs.AddNew($"Npc{suffix}");
        npc.Race.SetTo(race.FormKey);

        (cellKey, placedKey, npcKey, raceKey) = (cell.FormKey, placed.FormKey, npc.FormKey, race.FormKey);
    }

    private static ScatteredFixtureData StructuralFixture(
        string prefix, out FormKey cellKey, out FormKey placedKey, out FormKey npcKey, out FormKey raceKey)
    {
        FormKey cellA = default, placedA = default, npcA = default, raceA = default;
        FormKey cellB = default, placedB = default, npcB = default, raceB = default;
        var fixture = new PluginFixtureBuilder(prefix)
            .WithPlugin("Shared.esp", mod => PopulateStructuralInTheSameBuildOrderSoCorrespondingRecordsLandOnIdenticalFormKeys(mod, "A", out cellA, out placedA, out npcA, out raceA), origin: "ModA")
            .WithPlugin("Shared.esp", mod => PopulateStructuralInTheSameBuildOrderSoCorrespondingRecordsLandOnIdenticalFormKeys(mod, "B", out cellB, out placedB, out npcB, out raceB), origin: "ModB")
            .BuildScattered();

        Assert.Equal(cellA, cellB);
        Assert.Equal(placedA, placedB);
        Assert.Equal(npcA, npcB);
        Assert.Equal(raceA, raceB);
        (cellKey, placedKey, npcKey, raceKey) = (cellA, placedA, npcA, raceA);
        return fixture;
    }

    [Fact]
    public void TwoOrigins_SameFilenameSameFormKeys_PlacementCellLocationAndFormReferencesPersist_ThroughModAThenModBOnOneIndex()
    {
        using var fixture = StructuralFixture("identity-structural", out var cellKey, out var placedKey, out _, out var raceKey);
        using var index = Indexes.Open(_holder);

        void AssertOnlyTheWinningOriginHoldsTheRows(PluginAddress winner, PluginAddress other)
        {
            var reads = ReadsWithWinner(index, fixture, winner);
            Assert.NotNull(reads.GetCellLocation(winner, cellKey.ToString()));
            Assert.NotNull(reads.GetPlacement(placedKey.ToString(), winner));
            Assert.Null(reads.GetCellLocation(other, cellKey.ToString()));
            Assert.Null(reads.GetPlacement(placedKey.ToString(), other));
            Assert.Single(reads.GetReferencedBy(raceKey.ToString()), r => r.FieldPath == "Race");
        }

        AssertOnlyTheWinningOriginHoldsTheRows(winner: ModA, other: ModB);
        AssertOnlyTheWinningOriginHoldsTheRows(winner: ModB, other: ModA);
    }

    [Fact]
    public void TwoOrigins_SameFilenameSameFormKeys_GetReferencedBy_SurfacesOriginPerRow_ThroughModAThenModBOnOneIndex()
    {
        using var fixture = StructuralFixture("identity-references", out _, out _, out _, out var raceKey);
        using var index = Indexes.Open(_holder);

        void AssertTheReferenceCarriesTheWinningOrigin(PluginAddress winner)
        {
            var reference = Assert.Single(ReadsWithWinner(index, fixture, winner).GetReferencedBy(raceKey.ToString()));
            Assert.Equal(winner.Origin, reference.Origin);
        }

        AssertTheReferenceCarriesTheWinningOrigin(ModA);
        AssertTheReferenceCarriesTheWinningOrigin(ModB);
    }
}
