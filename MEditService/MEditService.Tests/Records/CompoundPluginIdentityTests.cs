using DuckDB.NET.Data;
using MEditService.Core.Edits;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.Tests.Records;

// ADR-0036: plugin identity is (origin, filename), not filename alone. These tests exercise
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

    // Both mods share ModKey "Shared.esp" and each adds exactly one NPC as their first record —
    // deterministic FormID assignment (see PluginParticipationTests) means the two NPCs land on the
    // identical FormKey, so this exercises the collision at its sharpest: same
    // form_key, same plugin filename, differing only in origin.
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
        repo.Index(modA, Registration.Participating(0), new PluginKey(modA.ModKey.FileName.ToString(), "ModA"));
        repo.Index(modB, Registration.Participating(1), new PluginKey(modB.ModKey.FileName.ToString(), "ModB"));

        var overrides = repo.GetOverrideStack(npcKey.ToString())!.Entries;

        Assert.Equal(2, overrides.Count);
        Assert.Contains(overrides, o => o.Effective.EditorId == "FromModA");
        Assert.Contains(overrides, o => o.Effective.EditorId == "FromModB");
    }

    // ADR-0036: GetRecord's plugin filter must pick one origin's copy over the other's.
    // origin is required (not defaulted) here: every real caller
    // (GetRecordForPlugin, GetPluginRecordTypes) already has plugin in
    // hand as a concrete, non-optional value, so this mirrors GetVmad/GetConditions/GetPlacement,
    // not GetRecords' nullable filter — the compiler must enumerate every call site.
    [Fact]
    public void TwoOrigins_SameFilenameSameFormKey_GetRecord_ScopesToRequestedOrigin()
    {
        var (modA, modB, npcKey) = BuildSharedFilenameFixture();

        using var repo = OpenRepo();
        repo.Index(modA, Registration.Participating(0), new PluginKey(modA.ModKey.FileName.ToString(), "ModA"));
        repo.Index(modB, Registration.Participating(1), new PluginKey(modB.ModKey.FileName.ToString(), "ModB"));

        var record = repo.GetDocument(npcKey.ToString(), new PluginKey("Shared.esp", "ModA"));

        Assert.NotNull(record);
        Assert.Equal("FromModA", record.EditorId);
        Assert.Equal("ModA", record.Plugin.Origin);
    }

    // ADR-0036: without origin scoping,
    // two same-filename origins' counts silently sum into one. origin is required here
    // (not defaulted) for the same reason as GetRecord's — plugin is never optional at this call
    // site (GetPluginRecordTypes always has a concrete plugin).
    [Fact]
    public void TwoOrigins_SameFilenameSameFormKey_CountRecordsForPlugin_CountsRequestedOriginOnly()
    {
        var (modA, modB, _) = BuildSharedFilenameFixture();

        using var repo = OpenRepo();
        repo.Index(modA, Registration.Participating(0), new PluginKey(modA.ModKey.FileName.ToString(), "ModA"));
        repo.Index(modB, Registration.Participating(1), new PluginKey(modB.ModKey.FileName.ToString(), "ModB"));

        Assert.Equal(1, repo.GetRecordTypeCounts(new PluginKey("Shared.esp", "ModA"))
            .FirstOrDefault(c => string.Equals(c.Type, "npc_", StringComparison.OrdinalIgnoreCase))?.Count ?? 0);
        Assert.Equal(1, repo.GetRecordTypeCounts(new PluginKey("Shared.esp", "ModB"))
            .FirstOrDefault(c => string.Equals(c.Type, "npc_", StringComparison.OrdinalIgnoreCase))?.Count ?? 0);
    }

    // ADR-0036: GetNativeFormKeys must not filter by plugin filename alone. Unlike
    // the fixtures above, this needs the two origins to hold genuinely *different* native FormKey
    // sets (BuildSharedFilenameFixture's single first-slot NPC lands both origins on the identical
    // FormKey, which can't distinguish a filter bug from a working one) — ModA gets one NPC, ModB
    // gets that same first NPC plus a second, so an origin-scoped read must see fewer FormKeys than
    // an unscoped one.
    [Fact]
    public void TwoOrigins_SameFilenameDifferentNativeFormKeys_GetNativeFormKeys_ScopesToRequestedOrigin()
    {
        var modA = new Fallout4Mod(ModKey.FromFileName("Shared.esp"), Fallout4Release.Fallout4);
        var sharedFirstKey = modA.Npcs.AddNew("First").FormKey;
        var modB = new Fallout4Mod(ModKey.FromFileName("Shared.esp"), Fallout4Release.Fallout4);
        modB.Npcs.AddNew("First");
        var secondKey = modB.Npcs.AddNew("SecondOnlyInModB").FormKey;

        using var repo = OpenRepo();
        repo.Index(modA, Registration.Participating(0), new PluginKey(modA.ModKey.FileName.ToString(), "ModA"));
        repo.Index(modB, Registration.Participating(1), new PluginKey(modB.ModKey.FileName.ToString(), "ModB"));

        var modAKeys = repo.GetNativeFormKeys(new PluginKey("Shared.esp", "ModA"));
        var modBKeys = repo.GetNativeFormKeys(new PluginKey("Shared.esp", "ModB"));

        Assert.Single(modAKeys);
        Assert.Equal(sharedFirstKey.ToString(), modAKeys[0]);
        Assert.Equal(2, modBKeys.Count);
        Assert.Contains(secondKey.ToString(), modBKeys);
    }

    // ADR-0036: a listing scoped to one filename must not silently merge both origins'
    // rows — RecordSummary surfaces Origin so they can be told apart.
    // origin is a nullable *filter* here (unlike the worldspace tree's required origin) because
    // plugin itself is optional on GetRecords — browsing every plugin's records is a legitimate
    // call with no origin to supply.
    [Fact]
    public void TwoOrigins_SameFilenameSameFormKey_GetRecords_FiltersToRequestedOriginAndSurfacesIt()
    {
        var (modA, modB, npcKey) = BuildSharedFilenameFixture();

        using var repo = OpenRepo();
        repo.Index(modA, Registration.Participating(0), new PluginKey(modA.ModKey.FileName.ToString(), "ModA"));
        repo.Index(modB, Registration.Participating(1), new PluginKey(modB.ModKey.FileName.ToString(), "ModB"));

        var modAResult = repo.Search(new RecordQuery(RecordTypes: ["npc_"], Plugin: new PluginKey("Shared.esp", "ModA"), Limit: 100, Offset: 0));

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
        // ModB sits later in its own load order and would incorrectly compute as winner if
        // UpdateWinners' join matched plugins by filename alone — ModA's participation is a
        // different origin's row entirely and must never leak into ModB's winner eligibility.
        repo.Index(modA, Registration.Participating(1), new PluginKey(modA.ModKey.FileName.ToString(), "ModA"));
        repo.Index(modB, Registration.Disabled(5), new PluginKey(modB.ModKey.FileName.ToString(), "ModB"));
        repo.UpdateWinners();

        var overrides = repo.GetOverrideStack(npcKey.ToString())!.Entries;
        var fromA = overrides.Single(o => o.Effective.EditorId == "FromModA");
        var fromB = overrides.Single(o => o.Effective.EditorId == "FromModB");

        Assert.True(fromA.IsWinner);
        Assert.False(fromB.IsWinner);
    }

    // Same structurally-identical-build-sequence trick as BuildSharedFilenameFixture, extended to
    // the re-keyed side tables: a worldspace/cell/placed-object chain (placement, cell_location)
    // and a scalar FormKey field (form_references), built in identical order for both mods so the
    // corresponding records land on identical FormKeys — the same collision, on the
    // three tables the earlier two tests above don't reach.
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
        repo.Index(modA, Registration.Participating(0), new PluginKey(modA.ModKey.FileName.ToString(), "ModA"));
        repo.Index(modB, Registration.Participating(1), new PluginKey(modB.ModKey.FileName.ToString(), "ModB"));

        Assert.Equal(2L, Count(repo, "cell_location", "cell_form_key", cellKeyA.ToString()));
        Assert.Equal(2L, Count(repo, "placement", "form_key", placedKeyA.ToString()));

        using var refCmd = repo.Connection.CreateCommand();
        refCmd.CommandText = "SELECT COUNT(*) FROM form_references WHERE source_form_key = $1 AND field_path = 'race'";
        refCmd.Parameters.Add(new DuckDBParameter { Value = npcKeyA.ToString() });
        Assert.Equal(2L, (long)refCmd.ExecuteScalar()!);
    }

    // ADR-0036: GetReferences never filters by plugin, so its result rows must carry Origin —
    // otherwise two same-filename sources referencing the same target (the exact scenario
    // TwoOrigins_SameFilenameSameFormKeys_PlacementCellLocationAndFormReferencesBothPersist proves
    // exists, at the form_references table) cannot be told apart by any caller of GetReferences.
    [Fact]
    public void TwoOrigins_SameFilenameSameFormKeys_GetReferences_SurfacesOriginPerRow()
    {
        var (modA, _, _, npcKeyA) = BuildStructuralMod("A");
        var (modB, _, _, npcKeyB) = BuildStructuralMod("B");
        Assert.Equal(npcKeyA, npcKeyB);
        var raceFormKey = modA.Races.First().FormKey.ToString();

        using var repo = OpenRepo();
        repo.Index(modA, Registration.Participating(0), new PluginKey(modA.ModKey.FileName.ToString(), "ModA"));
        repo.Index(modB, Registration.Participating(1), new PluginKey(modB.ModKey.FileName.ToString(), "ModB"));

        var refs = repo.GetReferencedBy(raceFormKey);

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
