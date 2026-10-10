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

    private OpenedIndex WithWinner(OpenedIndex index, ScatteredFixtureData fixture, PluginAddress winner) =>
        index.WithWinner(_holder, fixture.GameDirectory, fixture.Plugins, winner.Origin);

    private static readonly PluginAddress ModA = new("Shared.esp", "ModA");
    private static readonly PluginAddress ModB = new("Shared.esp", "ModB");

    private static ScatteredFixtureData SharedFilenameFixtureWhereDeterministicFormIdAssignmentGivesBothModsTheSameNpcFormKey(string prefix, out FormKey npcKey, bool modBEnabled = true, int modBLine = 1)
    {
        FormKey key = default;
        var fixture = new PluginFixtureBuilder(prefix)
            .WithPlugin("Shared.esp", mod => mod.Npcs.AddNew("FromModB"), origin: "ModB", enabled: modBEnabled)
            .WithPlugin("Shared.esp", mod => key = mod.Npcs.AddNew("FromModA").FormKey, origin: "ModA")
            .BuildScattered();
        npcKey = key;
        fixture.Plugins = [.. fixture.Plugins.Select(p => p.Origin == "ModB" ? p with { Line = modBLine } : p)];
        return fixture;
    }

    [Fact]
    public void TwoOrigins_SameFilenameSameFormKey_IndexBothWithoutCollidingOnDelete()
    {
        using var fixture = SharedFilenameFixtureWhereDeterministicFormIdAssignmentGivesBothModsTheSameNpcFormKey("identity-both", out var npcKey);
        using var index = Indexes.Open(_holder);

        string? EditorIdWhileWinning(PluginAddress winner) =>
            Assert.Single(WithWinner(index, fixture, winner).StackOf(npcKey.ToString())).EditorId;

        Assert.Equal("FromModA", EditorIdWhileWinning(ModA));
        Assert.Equal("FromModB", EditorIdWhileWinning(ModB));
    }

    [Fact]
    public void TwoOrigins_SameFilenameSameFormKey_GetRecord_ScopesToRequestedOrigin()
    {
        using var fixture = SharedFilenameFixtureWhereDeterministicFormIdAssignmentGivesBothModsTheSameNpcFormKey("identity-get", out var npcKey);
        using var index = Indexes.Reconciled(fixture);

        var record = index.DocumentOf(npcKey.ToString(), ModA);

        Assert.Equal("FromModA", record.EditorId);
        Assert.Equal("ModA", record.Origin);
    }

    [Fact]
    public void TwoOrigins_SameFilenameSameFormKey_CountRecordsForPlugin_CountsRequestedOriginOnly()
    {
        using var fixture = SharedFilenameFixtureWhereDeterministicFormIdAssignmentGivesBothModsTheSameNpcFormKey("identity-count", out _);
        using var index = Indexes.Open(_holder);
        WithWinner(index, fixture, ModA);

        Assert.Equal(1, index.CountOf(ModA, "npc_"));
        Assert.Equal(0, index.CountOf(ModB, "npc_"));
    }

    [Fact]
    public void TwoOrigins_SameFilenameSameFormKey_GetRecords_FiltersToRequestedOriginAndSurfacesIt()
    {
        using var fixture = SharedFilenameFixtureWhereDeterministicFormIdAssignmentGivesBothModsTheSameNpcFormKey("identity-list", out var npcKey);
        using var index = Indexes.Reconciled(fixture);

        var modAResult = index.Queries.GetRecords(["npc_"], ModA, search: null, limit: 100, offset: 0).Value();

        var item = Assert.Single(modAResult.Items);
        Assert.Equal(npcKey.ToString(), item.FormKey);
        Assert.Equal("FromModA", item.EditorId);
        Assert.Equal("ModA", item.Origin);
    }

    [Fact]
    public void TwoOrigins_SameFilenameSameFormKey_NonParticipatingOriginNeverWinsViaOtherOriginsParticipation()
    {
        const int modBLineLaterThanModAWhereAFilenameOnlyJoinWouldPickIt = 5;
        using var fixture = SharedFilenameFixtureWhereDeterministicFormIdAssignmentGivesBothModsTheSameNpcFormKey(
            "identity-winner", out var npcKey, modBEnabled: false, modBLine: modBLineLaterThanModAWhereAFilenameOnlyJoinWouldPickIt);
        using var index = Indexes.Reconciled(fixture);

        var only = Assert.Single(index.StackOf(npcKey.ToString()));

        Assert.Equal("FromModA", only.EditorId);
        Assert.True(only.IsWinner);
    }

    private static void PopulateStructuralInTheSameBuildOrderSoCorrespondingRecordsLandOnIdenticalFormKeys(Fallout4Mod mod, string suffix, out FormKey worldspaceKey, out FormKey cellKey, out FormKey placedKey, out FormKey npcKey, out FormKey raceKey)
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

        (worldspaceKey, cellKey, placedKey, npcKey, raceKey) = (wrld.FormKey, cell.FormKey, placed.FormKey, npc.FormKey, race.FormKey);
    }

    private static ScatteredFixtureData StructuralFixture(
        string prefix, out FormKey worldspaceKey, out FormKey cellKey, out FormKey placedKey, out FormKey raceKey)
    {
        FormKey worldspaceA = default, cellA = default, placedA = default, npcA = default, raceA = default;
        FormKey worldspaceB = default, cellB = default, placedB = default, npcB = default, raceB = default;
        var fixture = new PluginFixtureBuilder(prefix)
            .WithPlugin("Shared.esp", mod => PopulateStructuralInTheSameBuildOrderSoCorrespondingRecordsLandOnIdenticalFormKeys(mod, "A", out worldspaceA, out cellA, out placedA, out npcA, out raceA), origin: "ModA")
            .WithPlugin("Shared.esp", mod => PopulateStructuralInTheSameBuildOrderSoCorrespondingRecordsLandOnIdenticalFormKeys(mod, "B", out worldspaceB, out cellB, out placedB, out npcB, out raceB), origin: "ModB")
            .BuildScattered();

        Assert.Equal(worldspaceA, worldspaceB);
        Assert.Equal(cellA, cellB);
        Assert.Equal(placedA, placedB);
        Assert.Equal(npcA, npcB);
        Assert.Equal(raceA, raceB);
        (worldspaceKey, cellKey, placedKey, raceKey) = (worldspaceA, cellA, placedA, raceA);
        return fixture;
    }

    [Fact]
    public void TwoOrigins_SameFilenameSameFormKeys_PlacementCellLocationAndFormReferencesPersist_ThroughModAThenModBOnOneIndex()
    {
        using var fixture = StructuralFixture("identity-structural", out var worldspaceKey, out var cellKey, out var placedKey, out var raceKey);
        using var index = Indexes.Open(_holder);
        var (worldspace, cell, placed) = (worldspaceKey.ToString(), cellKey.ToString(), placedKey.ToString());

        bool CellIsLocatedIn(PluginAddress plugin) => index.Queries.GetWorldspaceBlocks(plugin, worldspace).Value().Blocks
            .SelectMany(b => b.SubBlocks).SelectMany(s => s.Cells).Any(c => c.FormKey == cell);

        void AssertOnlyTheWinningOriginHoldsTheRows(PluginAddress winner, PluginAddress other)
        {
            WithWinner(index, fixture, winner);
            Assert.True(CellIsLocatedIn(winner));
            Assert.NotNull(index.PlacementGroupIn(winner, cell, placed));
            Assert.False(CellIsLocatedIn(other));
            Assert.Null(index.PlacementGroupIn(other, cell, placed));
            Assert.Single(index.Queries.GetReferences(raceKey.ToString()).Value(), r => r.FieldPath == "Race");
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
            var reference = Assert.Single(WithWinner(index, fixture, winner).Queries.GetReferences(raceKey.ToString()).Value());
            Assert.Equal(winner.Origin, reference.Origin);
        }

        AssertTheReferenceCarriesTheWinningOrigin(ModA);
        AssertTheReferenceCarriesTheWinningOrigin(ModB);
    }
}
