using DuckDB.NET.Data;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Records;

// #583 / ADR-0001: load order lives only on `plugins`. Reordering `plugins.txt` — modelled here as
// two Register calls with swapped load_order_idx values and no re-index — touches one `plugins` row
// per plugin and no record: override stacks and conflict classification follow the new order purely
// from that join, exactly as they would from a re-index at the new order.
public class LoadOrderViaRegistrationTests
{
    private static readonly ISchemaReflector Reflector = SharedSchemaReflector.Instance;
    private static readonly ITableDdlBuilder Ddl = new TableDdlBuilder(Reflector);

    private static DuckDbRecordIndex OpenRepo()
    {
        var repo = new DuckDbRecordIndex(Reflector, Ddl, NullLogger.Instance);
        repo.Initialize(GameRelease.Fallout4);
        return repo;
    }

    private static long RawRecordCount(DuckDbRecordIndex repo, PluginKey key)
    {
        using var cmd = repo.Connection.CreateCommand();
        cmd.CommandText = "SELECT COUNT(*) FROM raw.records WHERE plugin = $1 AND origin = $2";
        cmd.Parameters.Add(new DuckDBParameter { Value = key.Name });
        cmd.Parameters.Add(new DuckDBParameter { Value = key.Origin! });
        return Convert.ToInt64(cmd.ExecuteScalar(), System.Globalization.CultureInfo.InvariantCulture);
    }

    [Fact]
    public void Reorder_ViaRegisterOnly_FlipsTheWinner_WithNoRecordRowTouched()
    {
        var fixture = new PluginFixtureBuilder("reorder-via-register")
            .WithPlugin("PluginA.esm", mod => mod.Npcs.AddNew("SharedNPC"))
            .Build();
        using var _ = fixture;

        var modA = (IModGetter)Fallout4Mod.CreateFromBinaryOverlay(
            new ModPath(ModKey.FromFileName("PluginA.esm"), Path.Combine(fixture.DataFolder, "PluginA.esm")),
            Fallout4Release.Fallout4);
        var npcKey = modA.EnumerateMajorRecords<INpcGetter>().First().FormKey;

        var modB = new Fallout4Mod(ModKey.FromFileName("PluginB.esp"), Fallout4Release.Fallout4);
        modB.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("PluginA.esm") });
        modB.Npcs.Set(modA.EnumerateMajorRecords<INpcGetter>().First().DeepCopy());

        var aKey = new PluginKey("PluginA.esm", "Data");
        var bKey = new PluginKey("PluginB.esp", "Data");

        using var repo = OpenRepo();
        repo.Index(modA, 0, participates: true, key: aKey);
        repo.Index((IModGetter)modB, 1, participates: true, key: bKey);
        repo.UpdateWinners();

        var beforeA = RawRecordCount(repo, aKey);
        var beforeB = RawRecordCount(repo, bKey);
        Assert.True(repo.GetOverrideStack(npcKey.ToString())!.Entries
            .Single(e => e.Plugin.Name == bKey.Name).IsWinner, "B, later in load order, should win before reorder.");

        // Reorder via `plugins` only — B now sorts before A — no Index() call.
        repo.Register(aKey, loadOrderIndex: 1, participates: true);
        repo.Register(bKey, loadOrderIndex: 0, participates: true);
        repo.UpdateWinners();

        var stack = repo.GetOverrideStack(npcKey.ToString())!.Entries;
        Assert.True(stack.Single(e => e.Plugin.Name == aKey.Name).IsWinner, "A, now later, should win after reorder.");
        Assert.False(stack.Single(e => e.Plugin.Name == bKey.Name).IsWinner);

        // The reorder never touched a record row.
        Assert.Equal(beforeA, RawRecordCount(repo, aKey));
        Assert.Equal(beforeB, RawRecordCount(repo, bKey));
    }
}
