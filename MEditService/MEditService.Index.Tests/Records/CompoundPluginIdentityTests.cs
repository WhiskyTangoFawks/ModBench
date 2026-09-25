using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.Index.Tests.Records;

// ADR-0012: plugin identity is (origin, filename), not filename alone. Two independently built
// plugins share a filename, each in its own mod folder.
public class CompoundPluginIdentityTests
{
    private static readonly PluginAddress ModA = new("Shared.esp", "ModA");
    private static readonly PluginAddress ModB = new("Shared.esp", "ModB");

    // Both mods share ModKey "Shared.esp" and each adds one NPC first, so deterministic FormID
    // assignment lands them on the identical FormKey: the collision at its sharpest, differing only
    // in origin.
    private static ScatteredFixtureData SharedFilenameFixture(string prefix, out FormKey npcKey, bool modBEnabled = true, int modBSlot = 1)
    {
        FormKey key = default;
        var fixture = new PluginFixtureBuilder(prefix)
            .WithPlugin("Shared.esp", mod => key = mod.Npcs.AddNew("FromModA").FormKey, origin: "ModA")
            .WithPlugin("Shared.esp", mod => mod.Npcs.AddNew("FromModB"), origin: "ModB", enabled: modBEnabled)
            .BuildScattered();
        npcKey = key;
        return fixture with
        {
            Plugins = [.. fixture.Plugins.Select(p => p.Origin == "ModB" ? p with { Slot = modBSlot } : p)],
        };
    }

    [Fact]
    public void TwoOrigins_SameFilenameSameFormKey_IndexBothWithoutCollidingOnDelete()
    {
        using var fixture = SharedFilenameFixture("identity-both", out var npcKey);
        using var index = Indexes.Reconciled(fixture);

        var overrideStack = index.RequireReads().GetOverrideStack(npcKey.ToString())
            ?? throw new InvalidOperationException($"Expected an override stack for '{npcKey}'.");
        var overrides = overrideStack.Entries;

        Assert.Equal(2, overrides.Count);
        Assert.Contains(overrides, o => o.Effective.EditorId == "FromModA");
        Assert.Contains(overrides, o => o.Effective.EditorId == "FromModB");
    }

    // ADR-0012: GetDocument's plugin filter must pick one origin's copy over the other's.
    [Fact]
    public void TwoOrigins_SameFilenameSameFormKey_GetRecord_ScopesToRequestedOrigin()
    {
        using var fixture = SharedFilenameFixture("identity-get", out var npcKey);
        using var index = Indexes.Reconciled(fixture);

        var record = index.RequireReads().GetDocument(npcKey.ToString(), ModA);

        Assert.NotNull(record);
        Assert.Equal("FromModA", record.EditorId);
        Assert.Equal("ModA", record.Plugin.Origin);
    }

    // ADR-0012: without origin scoping, two same-filename origins' counts silently sum into one.
    [Fact]
    public void TwoOrigins_SameFilenameSameFormKey_CountRecordsForPlugin_CountsRequestedOriginOnly()
    {
        using var fixture = SharedFilenameFixture("identity-count", out _);
        using var index = Indexes.Reconciled(fixture);
        var reads = index.RequireReads();

        Assert.Equal(1, reads.CountOf(ModA, "npc_"));
        Assert.Equal(1, reads.CountOf(ModB, "npc_"));
    }

    // ADR-0012: GetNativeFormKeys must not filter by plugin filename alone. The origins need genuinely
    // different FormKey sets, or a filter bug looks like a working one, so ModB carries a second NPC
    // and an origin-scoped read sees fewer keys.
    [Fact]
    public void TwoOrigins_SameFilenameDifferentNativeFormKeys_GetNativeFormKeys_ScopesToRequestedOrigin()
    {
        FormKey sharedFirstKey = default, secondKey = default;
        using var fixture = new PluginFixtureBuilder("identity-native")
            .WithPlugin("Shared.esp", mod => sharedFirstKey = mod.Npcs.AddNew("First").FormKey, origin: "ModA")
            .WithPlugin("Shared.esp", mod =>
            {
                mod.Npcs.AddNew("First");
                secondKey = mod.Npcs.AddNew("SecondOnlyInModB").FormKey;
            }, origin: "ModB")
            .BuildScattered();
        using var index = Indexes.Reconciled(fixture);
        var reads = index.RequireReads();

        var modAKeys = reads.GetNativeFormKeys(ModA);
        var modBKeys = reads.GetNativeFormKeys(ModB);

        Assert.Single(modAKeys);
        Assert.Equal(sharedFirstKey.ToString(), modAKeys[0]);
        Assert.Equal(2, modBKeys.Count);
        Assert.Contains(secondKey.ToString(), modBKeys);
    }

    // ADR-0012: a listing scoped to one filename must not silently merge both origins' rows.
    [Fact]
    public void TwoOrigins_SameFilenameSameFormKey_GetRecords_FiltersToRequestedOriginAndSurfacesIt()
    {
        using var fixture = SharedFilenameFixture("identity-list", out var npcKey);
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
        // ModB sits later in its own load order and would compute as winner if the sweep's join
        // matched by filename alone: ModA's participation is a different origin's row and must not
        // leak.
        using var fixture = SharedFilenameFixture("identity-winner", out var npcKey, modBEnabled: false, modBSlot: 5);
        using var index = Indexes.Reconciled(fixture);

        var overrideStack = index.RequireReads().GetOverrideStack(npcKey.ToString())
            ?? throw new InvalidOperationException($"Expected an override stack for '{npcKey}'.");
        var overrides = overrideStack.Entries;
        var fromA = overrides.Single(o => o.Effective.EditorId == "FromModA");
        var fromB = overrides.Single(o => o.Effective.EditorId == "FromModB");

        Assert.True(fromA.IsWinner);
        Assert.False(fromB.IsWinner);
    }

    // The same identical-build-sequence trick, extended to the re-keyed side tables, so the
    // corresponding records land on identical FormKeys: the same collision, on the placement,
    // cell-location and reference reads the tests above do not reach.
    private static void PopulateStructural(Fallout4Mod mod, string suffix, out FormKey cellKey, out FormKey placedKey, out FormKey npcKey, out FormKey raceKey)
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
            .WithPlugin("Shared.esp", mod => PopulateStructural(mod, "A", out cellA, out placedA, out npcA, out raceA), origin: "ModA")
            .WithPlugin("Shared.esp", mod => PopulateStructural(mod, "B", out cellB, out placedB, out npcB, out raceB), origin: "ModB")
            .BuildScattered();

        // Confirms the premise before testing the consequence: identical build order really does
        // produce identical FormKeys across the two independently-built mods.
        Assert.Equal(cellA, cellB);
        Assert.Equal(placedA, placedB);
        Assert.Equal(npcA, npcB);
        Assert.Equal(raceA, raceB);
        (cellKey, placedKey, npcKey, raceKey) = (cellA, placedA, npcA, raceA);
        return fixture;
    }

    [Fact]
    public void TwoOrigins_SameFilenameSameFormKeys_PlacementCellLocationAndFormReferencesBothPersist()
    {
        using var fixture = StructuralFixture("identity-structural", out var cellKey, out var placedKey, out _, out var raceKey);
        using var index = Indexes.Reconciled(fixture);
        var reads = index.RequireReads();

        foreach (var origin in new[] { ModA, ModB })
        {
            Assert.NotNull(reads.GetCellLocation(origin, cellKey.ToString()));
            Assert.NotNull(reads.GetPlacement(placedKey.ToString(), origin));
        }
        Assert.Equal(2, reads.GetReferencedBy(raceKey.ToString()).Count(r => r.FieldPath == "Race"));
    }

    // ADR-0012: GetReferencedBy never filters by plugin, so its rows must carry Origin, or two
    // same-filename sources referencing one target cannot be told apart by any caller.
    [Fact]
    public void TwoOrigins_SameFilenameSameFormKeys_GetReferences_SurfacesOriginPerRow()
    {
        using var fixture = StructuralFixture("identity-references", out _, out _, out _, out var raceKey);
        using var index = Indexes.Reconciled(fixture);

        var refs = index.RequireReads().GetReferencedBy(raceKey.ToString());

        Assert.Equal(2, refs.Count);
        Assert.Contains(refs, r => r.Origin == "ModA");
        Assert.Contains(refs, r => r.Origin == "ModB");
    }
}
