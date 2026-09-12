using DuckDB.NET.Data;
using MEditService.LoadOrder;
using MEditService.Index;
using MEditService.Codec.Schema;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Indexing;

public class IndexAtomicityTests
{
    private static readonly SchemaReflector Reflector = SharedSchemaReflector.Instance;
    private static readonly TableDdlBuilder Ddl = new TableDdlBuilder(Reflector);

    private static DuckDbRecordIndex OpenRepo()
    {
        var repo = new DuckDbRecordIndex(Reflector, Ddl, NullLogger.Instance);
        repo.Initialize(GameRelease.Fallout4);
        repo.CreateRecordTypeViews();
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

        // form_lookup, not form_references: it is appended unconditionally for any indexed record,
        // and its flush runs after the record-table appends, so without an enclosing transaction the
        // npc_ rows would survive the throw.
        using (var drop = repo.Connection.CreateCommand())
        {
            drop.CommandText = "DROP TABLE mirror.form_lookup";
            drop.ExecuteNonQuery();
        }

        var mod = LoadMod(fixture.DataFolder, "Atomic.esp");
        Assert.ThrowsAny<Exception>(() => repo.IndexMod(mod, Registration.Participating(0), new PluginKey(mod.ModKey.FileName.ToString(), "Data")));

        Assert.Equal(0, RowCount(repo, "npc_"));
    }
}
