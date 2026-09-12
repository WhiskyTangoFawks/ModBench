using DuckDB.NET.Data;
using MEditService.Codec.Schema;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.Tests.Records;

// ADR-0012: plugin identity is (origin, filename), not filename alone. These tests exercise
// the DuckDbRecordIndex seam directly with two independently-built Fallout4Mods that share a
// filename.
public class CompoundPluginIdentityTests
{
    private static readonly SchemaReflector Reflector = SharedSchemaReflector.Instance;
    private static readonly TableDdlBuilder Ddl = new TableDdlBuilder(Reflector);

    private static DuckDbRecordIndex OpenRepo()
    {
        var repo = new DuckDbRecordIndex(Reflector, Ddl, NullLogger.Instance);
        repo.Initialize(GameRelease.Fallout4);
        return repo;
    }

    // Both mods share ModKey "Shared.esp" and each adds one NPC first, so deterministic FormID
    // assignment lands them on the identical FormKey: the collision at its sharpest, differing only
    // in origin.
    private static (Fallout4Mod ModA, Fallout4Mod ModB, FormKey NpcKey) BuildSharedFilenameFixture()
    {
        var modA = new Fallout4Mod(ModKey.FromFileName("Shared.esp"), Fallout4Release.Fallout4);
        var npcA = modA.Npcs.AddNew("FromModA");
        var modB = new Fallout4Mod(ModKey.FromFileName("Shared.esp"), Fallout4Release.Fallout4);
        modB.Npcs.AddNew("FromModB");

        return (modA, modB, npcA.FormKey);
    }

    [Fact]
    public void TwoOrigins_SameFilenameSameFormKey_IndexBothWithoutCollidingOnDelete()
    {
        var (modA, modB, npcKey) = BuildSharedFilenameFixture();

        using var repo = OpenRepo();
        repo.IndexMod(modA, Registration.Participating(0), new PluginKey(modA.ModKey.FileName.ToString(), "ModA"));
        repo.IndexMod(modB, Registration.Participating(1), new PluginKey(modB.ModKey.FileName.ToString(), "ModB"));

        var overrides = repo.At(RecordRef.Effective).GetOverrideStack(npcKey.ToString())!.Entries;

        Assert.Equal(2, overrides.Count);
        Assert.Contains(overrides, o => o.Effective.EditorId == "FromModA");
        Assert.Contains(overrides, o => o.Effective.EditorId == "FromModB");
    }

    // ADR-0012: GetRecord's plugin filter must pick one origin's copy over the other's.
    [Fact]
    public void TwoOrigins_SameFilenameSameFormKey_GetRecord_ScopesToRequestedOrigin()
    {
        var (modA, modB, npcKey) = BuildSharedFilenameFixture();

        using var repo = OpenRepo();
        repo.IndexMod(modA, Registration.Participating(0), new PluginKey(modA.ModKey.FileName.ToString(), "ModA"));
        repo.IndexMod(modB, Registration.Participating(1), new PluginKey(modB.ModKey.FileName.ToString(), "ModB"));

        var record = repo.At(RecordRef.Effective).GetDocument(npcKey.ToString(), new PluginKey("Shared.esp", "ModA"));

        Assert.NotNull(record);
        Assert.Equal("FromModA", record.EditorId);
        Assert.Equal("ModA", record.Plugin.Origin);
    }

    // ADR-0012: without origin scoping, two same-filename origins' counts silently sum into one.
    [Fact]
    public void TwoOrigins_SameFilenameSameFormKey_CountRecordsForPlugin_CountsRequestedOriginOnly()
    {
        var (modA, modB, _) = BuildSharedFilenameFixture();

        using var repo = OpenRepo();
        repo.IndexMod(modA, Registration.Participating(0), new PluginKey(modA.ModKey.FileName.ToString(), "ModA"));
        repo.IndexMod(modB, Registration.Participating(1), new PluginKey(modB.ModKey.FileName.ToString(), "ModB"));

        Assert.Equal(1, repo.At(RecordRef.Effective).GetRecordTypeCounts(new PluginKey("Shared.esp", "ModA"))
            .FirstOrDefault(c => string.Equals(c.Type, "npc_", StringComparison.OrdinalIgnoreCase))?.Count ?? 0);
        Assert.Equal(1, repo.At(RecordRef.Effective).GetRecordTypeCounts(new PluginKey("Shared.esp", "ModB"))
            .FirstOrDefault(c => string.Equals(c.Type, "npc_", StringComparison.OrdinalIgnoreCase))?.Count ?? 0);
    }

    // ADR-0012: GetNativeFormKeys must not filter by plugin filename alone. The origins need genuinely
    // different FormKey sets, or a filter bug looks like a working one, so ModB carries a second NPC
    // and an origin-scoped read sees fewer keys.
    [Fact]
    public void TwoOrigins_SameFilenameDifferentNativeFormKeys_GetNativeFormKeys_ScopesToRequestedOrigin()
    {
        var modA = new Fallout4Mod(ModKey.FromFileName("Shared.esp"), Fallout4Release.Fallout4);
        var sharedFirstKey = modA.Npcs.AddNew("First").FormKey;
        var modB = new Fallout4Mod(ModKey.FromFileName("Shared.esp"), Fallout4Release.Fallout4);
        modB.Npcs.AddNew("First");
        var secondKey = modB.Npcs.AddNew("SecondOnlyInModB").FormKey;

        using var repo = OpenRepo();
        repo.IndexMod(modA, Registration.Participating(0), new PluginKey(modA.ModKey.FileName.ToString(), "ModA"));
        repo.IndexMod(modB, Registration.Participating(1), new PluginKey(modB.ModKey.FileName.ToString(), "ModB"));

        var modAKeys = repo.At(RecordRef.Effective).GetNativeFormKeys(new PluginKey("Shared.esp", "ModA"));
        var modBKeys = repo.At(RecordRef.Effective).GetNativeFormKeys(new PluginKey("Shared.esp", "ModB"));

        Assert.Single(modAKeys);
        Assert.Equal(sharedFirstKey.ToString(), modAKeys[0]);
        Assert.Equal(2, modBKeys.Count);
        Assert.Contains(secondKey.ToString(), modBKeys);
    }

    // ADR-0012: a listing scoped to one filename must not silently merge both origins' rows.
    [Fact]
    public void TwoOrigins_SameFilenameSameFormKey_GetRecords_FiltersToRequestedOriginAndSurfacesIt()
    {
        var (modA, modB, npcKey) = BuildSharedFilenameFixture();

        using var repo = OpenRepo();
        repo.IndexMod(modA, Registration.Participating(0), new PluginKey(modA.ModKey.FileName.ToString(), "ModA"));
        repo.IndexMod(modB, Registration.Participating(1), new PluginKey(modB.ModKey.FileName.ToString(), "ModB"));

        var modAResult = repo.At(RecordRef.Effective).Search(new RecordQuery(RecordTypes: ["npc_"], Plugin: new PluginKey("Shared.esp", "ModA"), Limit: 100, Offset: 0));

        var item = Assert.Single(modAResult.Items);
        Assert.Equal(npcKey.ToString(), item.FormKey);
        Assert.Equal("FromModA", item.EditorId);
        Assert.Equal("ModA", item.Origin);
    }

    [Fact]
    public void TwoOrigins_SameFilenameSameFormKey_NonParticipatingOriginNeverWinsViaOtherOriginsParticipation()
    {
        var (modA, modB, npcKey) = BuildSharedFilenameFixture();

        using var repo = OpenRepo();
        // ModB sits later in its own load order and would compute as winner if UpdateWinners' join
        // matched by filename alone: ModA's participation is a different origin's row and must not
        // leak.
        repo.IndexMod(modA, Registration.Participating(1), new PluginKey(modA.ModKey.FileName.ToString(), "ModA"));
        repo.IndexMod(modB, Registration.Disabled(5), new PluginKey(modB.ModKey.FileName.ToString(), "ModB"));
        repo.UpdateWinners();

        var overrides = repo.At(RecordRef.Effective).GetOverrideStack(npcKey.ToString())!.Entries;
        var fromA = overrides.Single(o => o.Effective.EditorId == "FromModA");
        var fromB = overrides.Single(o => o.Effective.EditorId == "FromModB");

        Assert.True(fromA.IsWinner);
        Assert.False(fromB.IsWinner);
    }

    // The same identical-build-sequence trick, extended to the re-keyed side tables, so the
    // corresponding records land on identical FormKeys: the same collision, on the three tables the
    // two tests above do not reach.
    private static (Fallout4Mod Mod, FormKey CellKey, FormKey PlacedKey, FormKey NpcKey) BuildStructuralMod(string suffix)
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Shared.esp"), Fallout4Release.Fallout4);

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

        return (mod, cell.FormKey, placed.FormKey, npc.FormKey);
    }

    [Fact]
    public void TwoOrigins_SameFilenameSameFormKeys_PlacementCellLocationAndFormReferencesBothPersist()
    {
        var (modA, cellKeyA, placedKeyA, npcKeyA) = BuildStructuralMod("A");
        var (modB, cellKeyB, placedKeyB, npcKeyB) = BuildStructuralMod("B");

        // Confirms the premise before testing the consequence: identical build order really does
        // produce identical FormKeys across the two independently-built mods.
        Assert.Equal(cellKeyA, cellKeyB);
        Assert.Equal(placedKeyA, placedKeyB);
        Assert.Equal(npcKeyA, npcKeyB);

        using var repo = OpenRepo();
        repo.IndexMod(modA, Registration.Participating(0), new PluginKey(modA.ModKey.FileName.ToString(), "ModA"));
        repo.IndexMod(modB, Registration.Participating(1), new PluginKey(modB.ModKey.FileName.ToString(), "ModB"));

        Assert.Equal(2L, Count(repo, "cell_location", "cell_form_key", cellKeyA.ToString()));
        Assert.Equal(2L, Count(repo, "placement", "form_key", placedKeyA.ToString()));

        using var refCmd = repo.Connection.CreateCommand();
        refCmd.CommandText = "SELECT COUNT(*) FROM form_references WHERE source_form_key = $1 AND field_path = 'Race'";
        refCmd.Parameters.Add(new DuckDBParameter { Value = npcKeyA.ToString() });
        Assert.Equal(2L, (long)refCmd.ExecuteScalar()!);
    }

    // ADR-0012: GetReferences never filters by plugin, so its rows must carry Origin, or two
    // same-filename sources referencing one target cannot be told apart by any caller.
    [Fact]
    public void TwoOrigins_SameFilenameSameFormKeys_GetReferences_SurfacesOriginPerRow()
    {
        var (modA, _, _, npcKeyA) = BuildStructuralMod("A");
        var (modB, _, _, npcKeyB) = BuildStructuralMod("B");
        Assert.Equal(npcKeyA, npcKeyB);
        var raceFormKey = modA.Races.First().FormKey.ToString();

        using var repo = OpenRepo();
        repo.IndexMod(modA, Registration.Participating(0), new PluginKey(modA.ModKey.FileName.ToString(), "ModA"));
        repo.IndexMod(modB, Registration.Participating(1), new PluginKey(modB.ModKey.FileName.ToString(), "ModB"));

        var refs = repo.At(RecordRef.Effective).GetReferencedBy(raceFormKey);

        Assert.Equal(2, refs.Count);
        Assert.Contains(refs, r => r.Origin == "ModA");
        Assert.Contains(refs, r => r.Origin == "ModB");
    }

    private static long Count(DuckDbRecordIndex repo, string table, string column, string value)
    {
        using var cmd = repo.Connection.CreateCommand();
        cmd.CommandText = $"SELECT COUNT(*) FROM \"{table}\" WHERE {column} = $1";
        cmd.Parameters.Add(new DuckDBParameter { Value = value });
        return (long)cmd.ExecuteScalar()!;
    }
}
