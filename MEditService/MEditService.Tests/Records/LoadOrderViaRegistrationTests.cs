using DuckDB.NET.Data;
using MEditService.Codec.Schema;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Records;

// ADR-0009: load order lives only on `registrations`. Reordering plugins.txt touches one
// registration row per plugin and no record, and override stacks and conflict classification
// follow the new order purely from that join.
public class LoadOrderViaRegistrationTests
{
    private static readonly SchemaReflector Reflector = SharedSchemaReflector.Instance;
    private static readonly TableDdlBuilder Ddl = new TableDdlBuilder(Reflector);

    private static DuckDbRecordIndex OpenRepo()
    {
        var repo = new DuckDbRecordIndex(Reflector, Ddl, NullLogger.Instance);
        repo.Initialize(GameRelease.Fallout4);
        return repo;
    }

    private static long MirrorRecordCount(DuckDbRecordIndex repo, PluginKey key)
    {
        using var cmd = repo.Connection.CreateCommand();
        cmd.CommandText = "SELECT COUNT(*) FROM mirror.records WHERE plugin = $1 AND origin = $2";
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
        repo.IndexMod(modA, Registration.Participating(0), aKey);
        repo.IndexMod((IModGetter)modB, Registration.Participating(1), bKey);
        repo.UpdateWinners();

        var beforeA = MirrorRecordCount(repo, aKey);
        var beforeB = MirrorRecordCount(repo, bKey);
        Assert.True(repo.At(RecordRef.Effective).GetOverrideStack(npcKey.ToString())!.Entries
            .Single(e => e.Plugin.Name == bKey.Name).IsWinner, "B, later in load order, should win before reorder.");

        // Reorder via `registrations` only — B now sorts before A — no Index() call.
        repo.Register(aKey, Registration.Participating(1));
        repo.Register(bKey, Registration.Participating(0));
        repo.UpdateWinners();

        var stack = repo.At(RecordRef.Effective).GetOverrideStack(npcKey.ToString())!.Entries;
        Assert.True(stack.Single(e => e.Plugin.Name == aKey.Name).IsWinner, "A, now later, should win after reorder.");
        Assert.False(stack.Single(e => e.Plugin.Name == bKey.Name).IsWinner);

        // The reorder never touched a record row.
        Assert.Equal(beforeA, MirrorRecordCount(repo, aKey));
        Assert.Equal(beforeB, MirrorRecordCount(repo, bKey));
    }
}
