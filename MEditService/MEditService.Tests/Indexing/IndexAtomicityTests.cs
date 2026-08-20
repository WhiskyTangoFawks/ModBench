using DuckDB.NET.Data;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Indexing;

public class IndexAtomicityTests
{
    private static readonly ISchemaReflector Reflector = SharedSchemaReflector.Instance;
    private static readonly ITableDdlBuilder Ddl = new TableDdlBuilder(Reflector);

    private static DuckDbRecordIndex OpenRepo()
    {
        var repo = new DuckDbRecordIndex(Reflector, Ddl, NullLogger.Instance);
        repo.Initialize(GameRelease.Fallout4);
        return repo;
    }

    private static IModGetter LoadMod(string dataFolder, string pluginName)
    {
        var modPath = new ModPath(ModKey.FromFileName(pluginName), Path.Combine(dataFolder, pluginName));
        return Fallout4Mod.CreateFromBinaryOverlay(modPath, Fallout4Release.Fallout4);
    }

    private static long RowCount(DuckDbRecordIndex repo, string table)
    {
        using var cmd = repo.Connection.CreateCommand();
        cmd.CommandText = $"SELECT COUNT(*) FROM \"{table}\"";
        return (long)cmd.ExecuteScalar()!;
    }

    [Fact]
    public void Index_ThrowingPartway_CommitsNoPartialRows()
    {
        using var fixture = new PluginFixtureBuilder("index-atomicity")
            .WithPlugin("Atomic.esp", mod => mod.Npcs.AddNew("AtomicNPC"))
            .Build();

        using var repo = OpenRepo();

        // Force a deterministic failure during the form_lookup flush phase, which runs after the
        // main record-table appends have already committed. Without an enclosing transaction the
        // npc_ rows would survive the throw as a partial snapshot.
        //
        // #420: VMAD/conditions no longer have side tables to drop for this purpose — both now
        // collect straight into the shared refs list, an in-memory step with nothing to fail against
        // until form_lookup/form_references' own flush later in Index(). form_lookup is
        // unconditionally appended for any indexed record (unlike form_references, which is skipped
        // entirely when refs is empty — as it is for this bare-NPC fixture), so it stays a reliable,
        // fixture-agnostic failure point.
        using (var drop = repo.Connection.CreateCommand())
        {
            drop.CommandText = "DROP TABLE form_lookup";
            drop.ExecuteNonQuery();
        }

        Assert.ThrowsAny<Exception>(() => repo.Index(LoadMod(fixture.DataFolder, "Atomic.esp"), 0, participates: true, origin: "Data"));

        Assert.Equal(0, RowCount(repo, "npc_"));
    }
}
