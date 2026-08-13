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

// #271 / ADR-0036: plugin identity is (origin, filename), not filename alone. These tests exercise
// the DuckDbRecordRepository seam directly with two independently-built Fallout4Mods that share a
// filename — the shape AC6 calls out explicitly ("even though nothing loads such a pair yet" via
// GameSession/SessionManager, which still dedupe by filename; #34's concern, not #271's).
public class CompoundPluginIdentityTests
{
    private static readonly ISchemaReflector Reflector = SharedSchemaReflector.Instance;
    private static readonly ITableDdlBuilder Ddl = new TableDdlBuilder(Reflector);

    private static DuckDbRecordRepository OpenRepo()
    {
        var repo = new DuckDbRecordRepository(Reflector, Ddl, NullLogger.Instance);
        repo.Initialize(GameRelease.Fallout4);
        return repo;
    }

    // Both mods share ModKey "Shared.esp" and each adds exactly one NPC as their first record —
    // deterministic FormID assignment (see PluginParticipationTests) means the two NPCs land on the
    // identical FormKey, so this exercises the collision AC6 describes at its sharpest: same
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
        repo.Index(modA, loadOrderIndex: 0, origin: "ModA", participates: true);
        repo.Index(modB, loadOrderIndex: 1, origin: "ModB", participates: true);

        var overrides = repo.GetAllOverrides("npc_", npcKey.ToString());

        Assert.Equal(2, overrides.Count);
        Assert.Contains(overrides, o => o.EditorId == "FromModA");
        Assert.Contains(overrides, o => o.EditorId == "FromModB");
    }

    // #296 / ADR-0036: GetRecord's own plugin filter couldn't pick one origin's copy over another's
    // even though the RecordDetail it returns has carried Origin since #272 — the one piece #272/#275
    // left unclosed for this method. origin is required (not defaulted) here: every real caller
    // (GetRecordForPlugin, GetPluginRecordTypes's staged-reconciliation lookup) already has plugin in
    // hand as a concrete, non-optional value, so this mirrors GetVmad/GetConditions/GetPlacement's
    // #275 precedent, not GetRecords' nullable filter — the compiler must enumerate every call site.
    [Fact]
    public void TwoOrigins_SameFilenameSameFormKey_GetRecord_ScopesToRequestedOrigin()
    {
        var (modA, modB, npcKey) = BuildSharedFilenameFixture();

        using var repo = OpenRepo();
        repo.Index(modA, loadOrderIndex: 0, origin: "ModA", participates: true);
        repo.Index(modB, loadOrderIndex: 1, origin: "ModB", participates: true);

        var record = repo.GetRecord("npc_", npcKey.ToString(), "Shared.esp", "ModA", winnerOnly: false);

        Assert.NotNull(record);
        Assert.Equal("FromModA", record.EditorId);
        Assert.Equal("ModA", record.Origin);
    }

    // #296 / ADR-0036: CountRecordsForPlugin reused GetRecords' BuildWhere but only ever supplied
    // plugin, so two same-filename origins' counts silently summed into one. origin is required here
    // (not defaulted) for the same reason as GetRecord's — plugin is never optional at this call
    // site (GetPluginRecordTypes always has a concrete plugin).
    [Fact]
    public void TwoOrigins_SameFilenameSameFormKey_CountRecordsForPlugin_CountsRequestedOriginOnly()
    {
        var (modA, modB, _) = BuildSharedFilenameFixture();

        using var repo = OpenRepo();
        repo.Index(modA, loadOrderIndex: 0, origin: "ModA", participates: true);
        repo.Index(modB, loadOrderIndex: 1, origin: "ModB", participates: true);

        Assert.Equal(1, repo.CountRecordsForPlugin("npc_", "Shared.esp", "ModA"));
        Assert.Equal(1, repo.CountRecordsForPlugin("npc_", "Shared.esp", "ModB"));
    }

    // #296 / ADR-0036: GetNativeFormKeys' per-table UNION filtered by plugin filename alone. Unlike
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
        repo.Index(modA, loadOrderIndex: 0, origin: "ModA", participates: true);
        repo.Index(modB, loadOrderIndex: 1, origin: "ModB", participates: true);

        var modAKeys = repo.GetNativeFormKeys("Shared.esp", "ModA");
        var modBKeys = repo.GetNativeFormKeys("Shared.esp", "ModB");

        Assert.Single(modAKeys);
        Assert.Equal(sharedFirstKey.ToString(), modAKeys[0]);
        Assert.Equal(2, modBKeys.Count);
        Assert.Contains(secondKey.ToString(), modBKeys);
    }

    // #296 / ADR-0036: GetRecords' outer WHERE filtered by plugin filename alone, and RecordSummary
    // carried no Origin at all — so a listing scoped to one filename silently merged both origins'
    // rows with no way to tell them apart, the same class of bug the worldspace tree reads had.
    // origin is a nullable *filter* here (unlike the worldspace tree's required origin) because
    // plugin itself is optional on GetRecords — browsing every plugin's records is a legitimate
    // call with no origin to supply.
    [Fact]
    public void TwoOrigins_SameFilenameSameFormKey_GetRecords_FiltersToRequestedOriginAndSurfacesIt()
    {
        var (modA, modB, npcKey) = BuildSharedFilenameFixture();

        using var repo = OpenRepo();
        repo.Index(modA, loadOrderIndex: 0, origin: "ModA", participates: true);
        repo.Index(modB, loadOrderIndex: 1, origin: "ModB", participates: true);

        var modAResult = repo.GetRecords("npc_", "Shared.esp", null, 100, 0, origin: "ModA");

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
        repo.Index(modA, loadOrderIndex: 1, participates: true, origin: "ModA");
        repo.Index(modB, loadOrderIndex: 5, participates: false, origin: "ModB");
        repo.UpdateWinners();

        var overrides = repo.GetAllOverrides("npc_", npcKey.ToString());
        var fromA = overrides.Single(o => o.EditorId == "FromModA");
        var fromB = overrides.Single(o => o.EditorId == "FromModB");

        Assert.True(fromA.IsWinner);
        Assert.False(fromB.IsWinner);
    }

    // Same structurally-identical-build-sequence trick as BuildSharedFilenameFixture, extended to the
    // side tables #271 also re-keyed: a worldspace/cell/placed-object chain (placement, cell_location)
    // and a scalar FormKey field (form_references), built in identical order for both mods so the
    // corresponding records land on identical FormKeys — the same collision AC6 describes, on the
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
        repo.Index(modA, loadOrderIndex: 0, origin: "ModA", participates: true);
        repo.Index(modB, loadOrderIndex: 1, origin: "ModB", participates: true);

        Assert.Equal(2L, Count(repo, "cell_location", "cell_form_key", cellKeyA.ToString()));
        Assert.Equal(2L, Count(repo, "placement", "form_key", placedKeyA.ToString()));

        using var refCmd = repo.Connection.CreateCommand();
        refCmd.CommandText = "SELECT COUNT(*) FROM form_references WHERE source_form_key = $1 AND field_path = 'race'";
        refCmd.Parameters.Add(new DuckDBParameter { Value = npcKeyA.ToString() });
        Assert.Equal(2L, (long)refCmd.ExecuteScalar()!);
    }

    // #296 / ADR-0036: GetReferences never filtered by plugin, but its result rows carried no
    // Origin either — so two same-filename sources referencing the same target (the exact scenario
    // TwoOrigins_SameFilenameSameFormKeys_PlacementCellLocationAndFormReferencesBothPersist proves
    // exists, at the form_references table) could not be told apart by any caller of GetReferences.
    [Fact]
    public void TwoOrigins_SameFilenameSameFormKeys_GetReferences_SurfacesOriginPerRow()
    {
        var (modA, _, _, npcKeyA) = BuildStructuralMod("A");
        var (modB, _, _, npcKeyB) = BuildStructuralMod("B");
        Assert.Equal(npcKeyA, npcKeyB);
        var raceFormKey = modA.Races.First().FormKey.ToString();

        using var repo = OpenRepo();
        // GetReferences' NOT EXISTS subquery reads pending_changes, which only DuckDbPendingChangeService's
        // own DDL creates — bind one to this repo's connection purely for that side effect, matching how
        // production shares one connection between the repository and the pending-change service.
        _ = new DuckDbPendingChangeService(repo.Connection);
        repo.Index(modA, loadOrderIndex: 0, origin: "ModA", participates: true);
        repo.Index(modB, loadOrderIndex: 1, origin: "ModB", participates: true);

        var refs = repo.GetReferences(raceFormKey);

        Assert.Equal(2, refs.Count);
        Assert.Contains(refs, r => r.Origin == "ModA");
        Assert.Contains(refs, r => r.Origin == "ModB");
    }

    private static long Count(DuckDbRecordRepository repo, string table, string column, string value)
    {
        using var cmd = repo.Connection.CreateCommand();
        cmd.CommandText = $"SELECT COUNT(*) FROM \"{table}\" WHERE {column} = $1";
        cmd.Parameters.Add(new DuckDBParameter { Value = value });
        return (long)cmd.ExecuteScalar()!;
    }
}
