using System.Globalization;
using DuckDB.NET.Data;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Indexing;

// Issue #1 slice A1: the header is indexed as a single row per plugin at the synthetic
// FormKey `000000:<plugin>`, bypassing the major-record indexing loop (ModHeader is never
// an IMajorRecordGetter) via a dedicated HeaderIndexer — mirroring the VmadIndexer/
// PlacementWalker precedent for structurally-foreign data.
public class HeaderIndexingTests
{
    private static readonly ISchemaReflector Reflector = SharedSchemaReflector.Instance;
    private static readonly ITableDdlBuilder Ddl = new TableDdlBuilder(Reflector);

    private static long ToLong(object? v) => Convert.ToInt64(v, CultureInfo.InvariantCulture);

    private static DuckDbRecordRepository NewRepo()
    {
        var repo = new DuckDbRecordRepository(Reflector, Ddl, NullLogger.Instance);
        repo.Initialize(GameRelease.Fallout4);
        return repo;
    }

    private static List<Dictionary<string, object?>> Query(DuckDbRecordRepository repo, string sql, params string[] parameters)
    {
        using var cmd = repo.Connection.CreateCommand();
        cmd.CommandText = sql;
        foreach (var p in parameters)
            cmd.Parameters.Add(new DuckDBParameter { Value = p });
        using var reader = cmd.ExecuteReader();
        var rows = new List<Dictionary<string, object?>>();
        while (reader.Read())
        {
            var row = new Dictionary<string, object?>();
            for (int i = 0; i < reader.FieldCount; i++)
                row[reader.GetName(i)] = reader.IsDBNull(i) ? null : reader.GetValue(i);
            rows.Add(row);
        }
        return rows;
    }

    [Fact]
    public void Index_Fo4Plugin_WritesHeaderRowWithSyntheticFormKey()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("HeaderTest.esp"), Fallout4Release.Fallout4);

        using var repo = NewRepo();
        repo.Index((IModGetter)mod, 0);

        var rows = Query(repo, "SELECT form_key FROM header WHERE plugin = $1", "HeaderTest.esp");
        var row = Assert.Single(rows);
        Assert.Equal("000000:HeaderTest.esp", row["form_key"]);
    }

    [Fact]
    public void Index_Header_AuthorColumn_MatchesModHeaderAuthor()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("AuthorTest.esp"), Fallout4Release.Fallout4);
        mod.ModHeader.Author = "Vault Dweller";

        using var repo = NewRepo();
        repo.Index((IModGetter)mod, 0);

        var rows = Query(repo, "SELECT author FROM header WHERE plugin = $1", "AuthorTest.esp");
        Assert.Equal("Vault Dweller", Assert.Single(rows)["author"]);
    }

    [Fact]
    public void Index_Header_FlagsColumn_ReflectsSmallMasterFlagForEsl()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("EslTest.esp"), Fallout4Release.Fallout4);
        mod.ModHeader.Flags = Fallout4ModHeader.HeaderFlag.Small;

        using var repo = NewRepo();
        repo.Index((IModGetter)mod, 0);

        var rows = Query(repo, "SELECT flags FROM header WHERE plugin = $1", "EslTest.esp");
        Assert.Equal((long)Fallout4ModHeader.HeaderFlag.Small, ToLong(Assert.Single(rows)["flags"]));
    }

    [Fact]
    public void Index_Header_MastersColumn_ListsPluginFilenamesInOrder()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("MastersTest.esp"), Fallout4Release.Fallout4);
        mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Fallout4.esm") });
        mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("DLCRobot.esm") });

        using var repo = NewRepo();
        repo.Index((IModGetter)mod, 0);

        var rows = Query(repo, "SELECT masters FROM header WHERE plugin = $1", "MastersTest.esp");
        var json = Assert.Single(rows)["masters"] as string;
        Assert.NotNull(json);
        var parsed = System.Text.Json.JsonSerializer.Deserialize<List<string>>(json);
        Assert.Equal(["Fallout4.esm", "DLCRobot.esm"], parsed);
    }

    [Fact]
    public void Index_ReIndexSamePlugin_ReplacesHeaderRowRatherThanDuplicating()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("ReindexHeader.esp"), Fallout4Release.Fallout4);

        using var repo = NewRepo();
        repo.Index((IModGetter)mod, 0);
        repo.Index((IModGetter)mod, 0);

        var rows = Query(repo, "SELECT COUNT(*) AS c FROM header WHERE plugin = $1", "ReindexHeader.esp");
        Assert.Equal(1L, rows[0]["c"]);
    }

    [Fact]
    public void Index_TwoPlugins_EachGetsOwnHeaderRow_NeitherOverridesTheOther()
    {
        var modA = new Fallout4Mod(ModKey.FromFileName("PluginA.esp"), Fallout4Release.Fallout4);
        var modB = new Fallout4Mod(ModKey.FromFileName("PluginB.esp"), Fallout4Release.Fallout4);

        using var repo = NewRepo();
        repo.Index((IModGetter)modA, 0);
        repo.Index((IModGetter)modB, 1);
        repo.UpdateWinners();

        var overridesA = repo.GetAllOverrides("header", "000000:PluginA.esp");
        var overridesB = repo.GetAllOverrides("header", "000000:PluginB.esp");

        Assert.Single(overridesA);
        Assert.Single(overridesB);
        Assert.Equal("PluginA.esp", overridesA[0].Plugin);
        Assert.Equal("PluginB.esp", overridesB[0].Plugin);
    }
}
