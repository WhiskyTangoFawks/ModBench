using System.Globalization;
using System.Text;
using System.Text.Json;
using DuckDB.NET.Data;
using MEditService.Codec.Schema;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.SourceRepo;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Indexing;

// The plugin header is an ordinary `records` row at the synthetic FormKey `000000:<plugin>`, whose
// body is the whole-mod door's root RecordData.json.
public class HeaderIndexingTests
{
    private static readonly SchemaReflector Reflector = SharedSchemaReflector.Instance;
    private static readonly TableDdlBuilder Ddl = new TableDdlBuilder(Reflector);

    private static long ToLong(object? v) => Convert.ToInt64(v, CultureInfo.InvariantCulture);

    private static DuckDbRecordIndex NewRepo()
    {
        var repo = new DuckDbRecordIndex(Reflector, Ddl, NullLogger.Instance);
        repo.Initialize(GameRelease.Fallout4);
        return repo;
    }

    private static DuckDbRecordIndex Indexed(IFallout4Mod mod, string origin = "Data")
    {
        var repo = NewRepo();
        repo.IndexMod((IModGetter)mod, Registration.Participating(0), new PluginKey(mod.ModKey.FileName.ToString(), origin));
        repo.UpdateWinners();
        return repo;
    }

    private static List<Dictionary<string, object?>> Query(DuckDbRecordIndex repo, string sql, params string[] parameters)
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

    private static object? FieldValueOf(RecordDocument doc, string name) =>
        doc.Fields.Single(f => f.Metadata.Name == name).Value;

    [Fact]
    public void Index_Fo4Plugin_WritesHeaderRowIntoRecords_WithSyntheticFormKeyAndHeaderType()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("HeaderTest.esp"), Fallout4Release.Fallout4);

        using var repo = Indexed(mod);

        var rows = Query(repo,
            "SELECT form_key, record_type, editor_id, \"ref\" FROM records WHERE record_type = 'header' AND plugin = $1",
            "HeaderTest.esp");
        var row = Assert.Single(rows);
        Assert.Equal("000000:HeaderTest.esp", row["form_key"]);
        Assert.Equal("header", row["record_type"]);
        // Headers have no EditorID concept — the one identity column that stays null.
        Assert.Null(row["editor_id"]);
        Assert.Equal(SourceRef.Committed, row["ref"]);
    }

    [Fact]
    public void Index_Header_BodyIsTheRootDocument_AndContentHashIsTheRepositorys()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("BodyTest.esp"), Fallout4Release.Fallout4);
        mod.ModHeader.Author = "Vault Dweller";

        using var repo = Indexed(mod);

        var row = Assert.Single(Query(repo,
            "SELECT body, content_hash FROM records WHERE record_type = 'header' AND plugin = $1", "BodyTest.esp"));
        var body = Assert.IsType<string>(row["body"]);

        // The root document's own shape, spelled out: the header nests one level inside a wrapper
        // carrying the mod's identity. This is what makes the header's column paths
        // "$.ModHeader.Author" rather than "$.Author".
        Assert.Contains("\"ModKey\": \"BodyTest.esp\"", body, StringComparison.Ordinal);
        Assert.Contains("\"GameRelease\": \"Fallout4\"", body, StringComparison.Ordinal);
        Assert.Contains("\"ModHeader\"", body, StringComparison.Ordinal);
        Assert.Contains("\"Author\": \"Vault Dweller\"", body, StringComparison.Ordinal);

        Assert.Equal(SourceRepository.ContentHash(Encoding.UTF8.GetBytes(body)), row["content_hash"]);
    }

    // The three fields the record editor renders for a header, read back through the ordinary document
    // path: each is the root document's own node at the column's path.
    [Fact]
    public void GetDocument_Header_AuthorField_MatchesModHeaderAuthor()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("AuthorTest.esp"), Fallout4Release.Fallout4);
        mod.ModHeader.Author = "Vault Dweller";

        using var repo = Indexed(mod);

        var doc = repo.At(RecordRef.Effective).GetDocument(PluginHeader.FormKeyFor(mod.ModKey), new PluginKey("AuthorTest.esp", "Data"));
        Assert.NotNull(doc);
        Assert.Equal("Vault Dweller", Assert.IsType<JsonElement>(FieldValueOf(doc, "Author")).GetString());
    }

    [Fact]
    public void GetDocument_Header_FlagsField_ReflectsSmallMasterFlagForEsl()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("EslTest.esp"), Fallout4Release.Fallout4);
        mod.ModHeader.Flags = Fallout4ModHeader.HeaderFlag.Small;

        using var repo = Indexed(mod);

        var doc = repo.At(RecordRef.Effective).GetDocument(PluginHeader.FormKeyFor(mod.ModKey), new PluginKey("EslTest.esp", "Data"));
        Assert.NotNull(doc);
        // The document spells the flags by Mutagen's member names.
        Assert.Equal(
            [nameof(Fallout4ModHeader.HeaderFlag.Small)],
            Assert.IsType<JsonElement>(FieldValueOf(doc, "Flags")).EnumerateArray().Select(e => e.GetString()));
    }

    [Fact]
    public void GetDocument_Header_MastersField_ListsPluginFilenamesInOrder()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("MastersTest.esp"), Fallout4Release.Fallout4);
        mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Fallout4.esm") });
        mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("DLCRobot.esm") });

        using var repo = Indexed(mod);

        var doc = repo.At(RecordRef.Effective).GetDocument(PluginHeader.FormKeyFor(mod.ModKey), new PluginKey("MastersTest.esp", "Data"));
        Assert.NotNull(doc);
        // The document's own shape: one object per master, naming it.
        var masters = Assert.IsType<JsonElement>(FieldValueOf(doc, "MasterReferences"));
        Assert.Equal(
            ["Fallout4.esm", "DLCRobot.esm"],
            masters.EnumerateArray().Select(e => e.GetProperty("Master").GetString() ?? "").ToList());
    }

    [Fact]
    public void HeaderSchema_MastersColumn_IsReadOnlyWithAReason()
    {
        var masters = Reflector.GetSchemas(GameRelease.Fallout4)[PluginHeader.RecordType]
            .RecordColumns.Single(c => c.Name == "MasterReferences");

        Assert.False(string.IsNullOrWhiteSpace(masters.ReadOnlyReason));
    }

    [Fact]
    public void Index_ReIndexSamePlugin_ReplacesHeaderRowRatherThanDuplicating()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("ReindexHeader.esp"), Fallout4Release.Fallout4);

        using var repo = NewRepo();
        var key = new PluginKey("ReindexHeader.esp", "Data");
        repo.IndexMod((IModGetter)mod, Registration.Participating(0), key);
        repo.IndexMod((IModGetter)mod, Registration.Participating(0), key);

        var rows = Query(repo,
            "SELECT COUNT(*) AS c FROM records WHERE record_type = 'header' AND plugin = $1", "ReindexHeader.esp");
        Assert.Equal(1L, ToLong(rows[0]["c"]));
    }

    [Fact]
    public void Index_Header_GetsItsOwnFormLookupRow_LikeEveryOtherRecord()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("LookupHeader.esp"), Fallout4Release.Fallout4);
        mod.Npcs.AddNew().EditorID = "SomeNpc";

        using var repo = Indexed(mod);

        var records = ToLong(Assert.Single(Query(repo,
            "SELECT COUNT(*) AS c FROM records WHERE plugin = $1", "LookupHeader.esp"))["c"]);
        var lookups = ToLong(Assert.Single(Query(repo,
            "SELECT COUNT(*) AS c FROM form_lookup WHERE plugin = $1", "LookupHeader.esp"))["c"]);

        // Positive control: more than just the header, or the equality below is a 1==1 that would
        // hold even if records rows stopped producing lookup rows entirely.
        Assert.True(records > 1, $"expected the header and at least one record; got {records}");
        Assert.Equal(records, lookups);

        var resolved = repo.At(RecordRef.Effective).Resolve(PluginHeader.FormKeyFor(mod.ModKey));
        Assert.NotNull(resolved);
        Assert.Equal("header", resolved.Value.RecordType);
        Assert.Null(resolved.Value.EditorId);
    }

    [Fact]
    public void Index_TwoPlugins_EachGetsOwnHeaderRow_NeitherOverridesTheOther()
    {
        var modA = new Fallout4Mod(ModKey.FromFileName("PluginA.esp"), Fallout4Release.Fallout4);
        var modB = new Fallout4Mod(ModKey.FromFileName("PluginB.esp"), Fallout4Release.Fallout4);

        using var repo = NewRepo();
        repo.IndexMod((IModGetter)modA, Registration.Participating(0), new PluginKey(modA.ModKey.FileName.ToString(), "Data"));
        repo.IndexMod((IModGetter)modB, Registration.Participating(1), new PluginKey(modB.ModKey.FileName.ToString(), "Data"));
        repo.UpdateWinners();

        var overridesA = repo.At(RecordRef.Effective).GetOverrideStack("000000:PluginA.esp")!.Entries;
        var overridesB = repo.At(RecordRef.Effective).GetOverrideStack("000000:PluginB.esp")!.Entries;

        Assert.Single(overridesA);
        Assert.Single(overridesB);
        Assert.Equal("PluginA.esp", overridesA[0].Plugin.Name);
        Assert.Equal("PluginB.esp", overridesB[0].Plugin.Name);
    }

    // ADR-0012: two origins loading the same physical filename — a filename-only delete step would
    // make indexing ModB's copy of a shared-filename plugin silently delete ModA's header row before
    // inserting ModB's.
    [Fact]
    public void Index_TwoOrigins_SameFilename_EachGetsOwnHeaderRow_NeitherOverridesTheOther()
    {
        var modA = new Fallout4Mod(ModKey.FromFileName("Shared.esp"), Fallout4Release.Fallout4);
        modA.ModHeader.Author = "Author A";
        var modB = new Fallout4Mod(ModKey.FromFileName("Shared.esp"), Fallout4Release.Fallout4);
        modB.ModHeader.Author = "Author B";

        using var repo = NewRepo();
        repo.IndexMod((IModGetter)modA, Registration.Participating(0), new PluginKey(modA.ModKey.FileName.ToString(), "ModA"));
        repo.IndexMod((IModGetter)modB, Registration.Participating(1), new PluginKey(modB.ModKey.FileName.ToString(), "ModB"));

        var overrides = repo.At(RecordRef.Effective).GetOverrideStack("000000:Shared.esp")!.Entries;

        Assert.Equal(2, overrides.Count);
        Assert.Contains(overrides, o => o.Plugin.Origin == "ModA");
        Assert.Contains(overrides, o => o.Plugin.Origin == "ModB");

        // ...and each carries its own author through, which is the fact a filename-scoped delete
        // would destroy.
        Assert.Equal("Author A", Assert.IsType<JsonElement>(FieldValueOf(overrides.Single(o => o.Plugin.Origin == "ModA").Effective, "Author")).GetString());
        Assert.Equal("Author B", Assert.IsType<JsonElement>(FieldValueOf(overrides.Single(o => o.Plugin.Origin == "ModB").Effective, "Author")).GetString());
    }

}
