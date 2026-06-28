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
    private static readonly ISchemaReflector _reflector = new SchemaReflector();
    private static readonly ITableDdlBuilder _ddl = new TableDdlBuilder(_reflector);

    private static DuckDbRecordRepository OpenRepo()
    {
        var repo = new DuckDbRecordRepository(_reflector, _ddl, NullLogger.Instance);
        repo.Initialize(GameRelease.Fallout4);
        return repo;
    }

    private static IModGetter LoadMod(string dataFolder, string pluginName)
    {
        var modPath = new ModPath(ModKey.FromFileName(pluginName), Path.Combine(dataFolder, pluginName));
        return Fallout4Mod.CreateFromBinaryOverlay(modPath, Fallout4Release.Fallout4);
    }

    private static long RowCount(DuckDbRecordRepository repo, string table)
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

        // Force a deterministic failure during the VMAD phase, which runs after the main
        // record-table appends have already flushed. Without an enclosing transaction the
        // npc_ rows would survive the throw as a partial snapshot.
        using (var drop = repo.Connection.CreateCommand())
        {
            drop.CommandText = "DROP TABLE vmad_properties";
            drop.ExecuteNonQuery();
        }

        Assert.ThrowsAny<Exception>(() => repo.Index(LoadMod(fixture.DataFolder, "Atomic.esp"), 0));

        Assert.Equal(0, RowCount(repo, "npc_"));
    }
}
