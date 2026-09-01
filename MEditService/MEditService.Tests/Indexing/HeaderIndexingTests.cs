using System.Globalization;
using System.Text;
using System.Text.Json;
using DuckDB.NET.Data;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Indexing;

// #631: the plugin header is an ordinary `records` row at the synthetic FormKey
// `000000:<plugin>`, whose body is the whole-mod door's root RecordData.json. It still bypasses the
// major-record indexing loop (a ModHeader is never an IMajorRecordGetter) via HeaderIndexer, but
// that is now the only thing special about it — it carries record_type/ref/body/content_hash like
// every other row, and is read back through the ordinary document path.
//
// These assertions are deliberately expressed against `records` and the read model rather than
// against a per-type table's columns, which is the whole point of the change: the shape they used to
// pin (SELECT author FROM header) no longer exists to be pinned.
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
        repo.Index((IModGetter)mod, Registration.Participating(0), new PluginKey(mod.ModKey.FileName.ToString(), origin));
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

    /// <summary>
    /// The row's body is the whole-mod door's root document, not some re-rendering of it — and its
    /// content_hash is the git object name of exactly those bytes, which is what lets a tracked
    /// plugin's header be compared against its own source file in one ref read.
    ///
    /// <para>The hash is checked against <c>GitBlobHash.Of</c> rather than against real
    /// <c>git hash-object</c>, which would be tautological were that all this rested on — but it is
    /// not: <c>GitBlobHashTests</c> already pins <c>GitBlobHash.Of</c> against the real git oracle,
    /// so what this asserts is the claim that is actually open here, that ingest hashes <i>this
    /// row's own body bytes</i> and not something else.</para>
    /// </summary>
    [Fact]
    public void Index_Header_BodyIsTheRootDocument_AndContentHashIsItsGitBlobHash()
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

        Assert.Equal(GitBlobHash.Of(Encoding.UTF8.GetBytes(body)), row["content_hash"]);
    }

    // The three fields the record editor renders for a header, read back through the ordinary
    // document path. These are the same assertions the retired wide table's column tests made — same
    // values, same types — because the extraction delegates did not change, only the object they run
    // against (HeaderColumnExtract over the mod the body reads back into).
    [Fact]
    public void GetDocument_Header_AuthorField_MatchesModHeaderAuthor()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("AuthorTest.esp"), Fallout4Release.Fallout4);
        mod.ModHeader.Author = "Vault Dweller";

        using var repo = Indexed(mod);

        var doc = repo.At(RecordRef.Effective).GetDocument(HeaderIndexer.FormKeyFor(mod.ModKey), new PluginKey("AuthorTest.esp", "Data"));
        Assert.NotNull(doc);
        Assert.Equal("Vault Dweller", FieldValueOf(doc, "author"));
    }

    [Fact]
    public void GetDocument_Header_FlagsField_ReflectsSmallMasterFlagForEsl()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("EslTest.esp"), Fallout4Release.Fallout4);
        mod.ModHeader.Flags = Fallout4ModHeader.HeaderFlag.Small;

        using var repo = Indexed(mod);

        var doc = repo.At(RecordRef.Effective).GetDocument(HeaderIndexer.FormKeyFor(mod.ModKey), new PluginKey("EslTest.esp", "Data"));
        Assert.NotNull(doc);
        // A bitmask column renders as a decimal string, exactly as it did when read off the wide
        // table's INTEGER column — the shared normalization in DuckDbRecordIndex.BuildFields.
        Assert.Equal(
            ((long)Fallout4ModHeader.HeaderFlag.Small).ToString(CultureInfo.InvariantCulture),
            FieldValueOf(doc, "flags"));
    }

    [Fact]
    public void GetDocument_Header_MastersField_ListsPluginFilenamesInOrder()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("MastersTest.esp"), Fallout4Release.Fallout4);
        mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Fallout4.esm") });
        mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("DLCRobot.esm") });

        using var repo = Indexed(mod);

        var doc = repo.At(RecordRef.Effective).GetDocument(HeaderIndexer.FormKeyFor(mod.ModKey), new PluginKey("MastersTest.esp", "Data"));
        Assert.NotNull(doc);
        // An array column surfaces as a JsonElement of bare filename strings — deliberately NOT the
        // document's own [{ "Master": ... }] shape, which is what the masters extractor flattens.
        var masters = Assert.IsType<JsonElement>(FieldValueOf(doc, "masters"));
        Assert.Equal(
            ["Fallout4.esm", "DLCRobot.esm"],
            masters.EnumerateArray().Select(e => e.GetString() ?? "").ToList());
    }

    /// <summary>
    /// #335/ADR-0038: masters are wholly content-derived at compile time, so the column carries no
    /// write delegate. Not currently reachable through EditField (a header FormKey refuses earlier at
    /// SourceUnitNotFound — see HeaderIndexer.MastersFieldName), so this pins the leaf guard where it
    /// actually lives rather than through a write that never gets there.
    /// </summary>
    [Fact]
    public void HeaderSchema_MastersColumn_CarriesNoWriteDelegate()
    {
        var masters = Reflector.GetSchemas(GameRelease.Fallout4)[HeaderIndexer.RecordType]
            .RecordColumns.Single(c => c.Name == HeaderIndexer.MastersFieldName);

        Assert.Null(masters.Apply);
    }

    [Fact]
    public void Index_ReIndexSamePlugin_ReplacesHeaderRowRatherThanDuplicating()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("ReindexHeader.esp"), Fallout4Release.Fallout4);

        using var repo = NewRepo();
        var key = new PluginKey("ReindexHeader.esp", "Data");
        repo.Index((IModGetter)mod, Registration.Participating(0), key);
        repo.Index((IModGetter)mod, Registration.Participating(0), key);

        var rows = Query(repo,
            "SELECT COUNT(*) AS c FROM records WHERE record_type = 'header' AND plugin = $1", "ReindexHeader.esp");
        Assert.Equal(1L, ToLong(rows[0]["c"]));
    }

    /// <summary>
    /// ADR-0031: exactly one <c>form_lookup</c> row per <c>records</c> row — the header included
    /// since #631, which is what makes its FormKey resolvable the same way every other one is rather
    /// than through a lookup of its own.
    /// </summary>
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

        var resolved = repo.At(RecordRef.Effective).Resolve(HeaderIndexer.FormKeyFor(mod.ModKey));
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
        repo.Index((IModGetter)modA, Registration.Participating(0), new PluginKey(modA.ModKey.FileName.ToString(), "Data"));
        repo.Index((IModGetter)modB, Registration.Participating(1), new PluginKey(modB.ModKey.FileName.ToString(), "Data"));
        repo.UpdateWinners();

        var overridesA = repo.At(RecordRef.Effective).GetOverrideStack("000000:PluginA.esp")!.Entries;
        var overridesB = repo.At(RecordRef.Effective).GetOverrideStack("000000:PluginB.esp")!.Entries;

        Assert.Single(overridesA);
        Assert.Single(overridesB);
        Assert.Equal("PluginA.esp", overridesA[0].Plugin.Name);
        Assert.Equal("PluginB.esp", overridesB[0].Plugin.Name);
    }

    // ADR-0036: two origins loading the same physical filename — a filename-only delete step would
    // make indexing ModB's copy of a shared-filename plugin silently delete ModA's header row before
    // inserting ModB's. Mirrors PlacementIndexingTests.GetPlacement_SameFilenameDifferentOrigin_
    // ScopesToOrigin's origin: "ModA"/"ModB" pattern.
    [Fact]
    public void Index_TwoOrigins_SameFilename_EachGetsOwnHeaderRow_NeitherOverridesTheOther()
    {
        var modA = new Fallout4Mod(ModKey.FromFileName("Shared.esp"), Fallout4Release.Fallout4);
        modA.ModHeader.Author = "Author A";
        var modB = new Fallout4Mod(ModKey.FromFileName("Shared.esp"), Fallout4Release.Fallout4);
        modB.ModHeader.Author = "Author B";

        using var repo = NewRepo();
        repo.Index((IModGetter)modA, Registration.Participating(0), new PluginKey(modA.ModKey.FileName.ToString(), "ModA"));
        repo.Index((IModGetter)modB, Registration.Participating(1), new PluginKey(modB.ModKey.FileName.ToString(), "ModB"));

        var overrides = repo.At(RecordRef.Effective).GetOverrideStack("000000:Shared.esp")!.Entries;

        Assert.Equal(2, overrides.Count);
        Assert.Contains(overrides, o => o.Plugin.Origin == "ModA");
        Assert.Contains(overrides, o => o.Plugin.Origin == "ModB");

        // ...and each carries its own author through, which is the fact a filename-scoped delete
        // would destroy.
        Assert.Equal("Author A", FieldValueOf(overrides.Single(o => o.Plugin.Origin == "ModA").Effective, "author"));
        Assert.Equal("Author B", FieldValueOf(overrides.Single(o => o.Plugin.Origin == "ModB").Effective, "author"));
    }

}
