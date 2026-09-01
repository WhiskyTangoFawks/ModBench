using System.Globalization;
using MEditService.Core.Records;
using MEditService.Core.Serialization;
using MEditService.Core.Source;
using MEditService.Tests.RealData;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Order;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Records;

/// <summary>
/// Ingest writes one <c>records</c> document per major record — the table that replaces the
/// reflected per-type wide tables (ADR-0041).
///
/// Asserted <b>through the SQL door</b> (plain <c>SELECT</c> against the connection), not through
/// <c>IRecordReads</c>, deliberately: the published relational schema is a contract in its own right
/// for user filter SQL and <c>medit.query</c> scripts (invariant 8), and the typed C# surface is
/// explicitly *not* that contract. A test that could only see this table through a repository method
/// would pass just as happily if the table were shaped wrong but the method compensated.
///
/// The body is asserted against <see cref="RecordTextCodec"/>'s own bytes rather than against a
/// literal: ADR-0041's claim is not "some JSON is stored" but "the same bytes as the source file",
/// which is precisely what makes <c>content_hash</c> comparable to a git object and what a byte
/// compare will later stand on.
/// </summary>
public sealed class RecordsDocumentTableTests(CutDownPluginFixture fixture) : IClassFixture<CutDownPluginFixture>
{
    private readonly CutDownPluginFixture _fixture = fixture;

    private static IModDisposeGetter OpenPlugin() => ModFactory.ImportGetter(
        new ModPath(ModKey.FromFileName(CutDownPluginFixture.PluginFileName), CutDownPluginFixture.PluginPath),
        GameRelease.Fallout4);

    private object? Scalar(string sql, params string[] parameters)
    {
        using var cmd = _fixture.Repo.Connection.CreateCommand();
        cmd.CommandText = sql;
        foreach (var p in parameters)
            cmd.Parameters.Add(new DuckDB.NET.Data.DuckDBParameter { Value = p });
        return cmd.ExecuteScalar();
    }

    /// <summary>
    /// One document per record of every <i>indexed</i> type. The expected count is built by walking
    /// the reflected schemas against the same file rather than pinned as a literal, so regenerating
    /// the curated plugin cannot quietly turn this into an assertion about a stale corpus.
    /// </summary>
    [Fact]
    public void Index_WritesOneDocumentPerRecordOfEveryIndexedType()
    {
        using var overlay = OpenPlugin();
        // The header is excluded from the enumeration (a ModHeader is not an IMajorRecordGetter, so
        // EnumerateMajorRecords cannot reach it) and added back as the one row it contributes — since
        // #631 it is an ordinary `records` row, so leaving it out would under-count by exactly one
        // per plugin.
        var expected = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4)
            .Where(kv => kv.Key != HeaderIndexer.RecordType)
            .Sum(kv => overlay.EnumerateMajorRecords(kv.Value.RecordType, throwIfUnknown: false).Count())
            + 1;

        var actual = Convert.ToInt64(Scalar("SELECT COUNT(*) FROM records"), CultureInfo.InvariantCulture);

        Assert.True(expected > 0, "The cut-down plugin should contain records of indexed types.");
        Assert.Equal(expected, actual);
    }

    /// <summary>
    /// The document set is scoped to the types the schema reflects, exactly as the per-type wide
    /// tables were — a deliberate product filter, not an accident of enumeration. LAND/NAVM/NAVI are
    /// not editable refs (<c>SchemaReflector.NonEditableRefTypes</c>), no read surface has ever
    /// exposed them, and no generated view will; serializing them would spend real ingest time and
    /// real memory (navmeshes are large) on documents with no consumer.
    ///
    /// Stated as a *paired* assertion rather than a bare absence: the plugin genuinely contains
    /// records of these types (the positive control — otherwise "none were stored" is vacuously true
    /// of a corpus that had none to store), and the same query that finds none of them finds plenty
    /// of an indexed type through the identical path.
    /// </summary>
    [Fact]
    public void Index_ExcludesTheNonEditableRefTypesTheSchemaAlsoExcludes()
    {
        using var overlay = OpenPlugin();
        // By getter interface, not runtime type name: a binary overlay's concrete types are
        // LandscapeBinaryOverlay / NavigationMeshBinaryOverlay, so a name comparison here silently
        // counts zero and turns the control it is supposed to be into a no-op.
        var presentInPlugin = overlay.EnumerateMajorRecords<ILandscapeGetter>(throwIfUnknown: false).Count()
            + overlay.EnumerateMajorRecords<INavigationMeshGetter>(throwIfUnknown: false).Count();
        Assert.True(presentInPlugin > 0,
            "Positive control: the cut-down plugin must actually contain LAND/NAVM records for their absence to mean anything.");

        var excluded = Convert.ToInt64(
            Scalar("SELECT COUNT(*) FROM records WHERE record_type IN ('land', 'navm', 'navi')"),
            CultureInfo.InvariantCulture);
        var indexed = Convert.ToInt64(
            Scalar("SELECT COUNT(*) FROM records WHERE record_type = 'npc_'"), CultureInfo.InvariantCulture);

        Assert.Equal(0, excluded);
        Assert.True(indexed > 0, "Positive control: the same query path must find documents of an indexed type.");
    }

    /// <summary>
    /// The body is the codec's source text, byte for byte. A non-container record here on purpose:
    /// containers need the ingest-side child strip, which has its own
    /// test — pinning a Cell here would conflate the two.
    /// </summary>
    [Fact]
    public async Task Index_DocumentBody_IsTheCodecsSourceText()
    {
        using var overlay = OpenPlugin();
        var record = ((IFallout4ModGetter)overlay).Npcs.First();
        var expected = await new RecordTextCodec(NullLogger<RecordTextCodec>.Instance)
            .SerializeToBytesAsync(record, GameRelease.Fallout4);

        var body = (string?)Scalar("SELECT body FROM records WHERE form_key = $1", record.FormKey.ToString());

        Assert.NotNull(body);
        Assert.Equal(System.Text.Encoding.UTF8.GetString(expected), body);
    }

    /// <summary>
    /// content_hash is the git blob hash of the body that sits beside it — the two columns must
    /// agree row-by-row, or the aggregate that reads them ("every plugin says the same thing about
    /// this record") is reading a hash of something other than what it is about to show.
    /// </summary>
    [Fact]
    public void Index_ContentHash_IsTheGitBlobHashOfTheStoredBody()
    {
        using var cmd = _fixture.Repo.Connection.CreateCommand();
        cmd.CommandText = "SELECT form_key, body, content_hash FROM records";
        using var reader = cmd.ExecuteReader();

        var checked_ = 0;
        var mismatches = new List<string>();
        while (reader.Read())
        {
            var stored = reader.GetString(2);
            var recomputed = GitBlobHash.Of(System.Text.Encoding.UTF8.GetBytes(reader.GetString(1)));
            if (!string.Equals(stored, recomputed, StringComparison.Ordinal))
                mismatches.Add($"{reader.GetString(0)}: stored {stored} != {recomputed}");
            checked_++;
        }

        Assert.True(checked_ > 0, "Expected documents to check.");
        Assert.Empty(mismatches);
    }

    /// <summary>
    /// The identity columns the read model is rebuilt on. `ref` is here with its one committed
    /// value and no machinery behind it — ADR-0041 spells it into the published table shape; the
    /// second value belongs to the edit path.
    /// </summary>
    [Fact]
    public void Index_Document_CarriesItsIdentityColumns()
    {
        using var overlay = OpenPlugin();
        var record = ((IFallout4ModGetter)overlay).Npcs.First(n => n.EditorID != null);

        using var cmd = _fixture.Repo.Connection.CreateCommand();
        cmd.CommandText = """
            SELECT plugin, origin, record_type, editor_id, load_order_idx, is_winner, "ref"
            FROM records WHERE form_key = $1
            """;
        cmd.Parameters.Add(new DuckDB.NET.Data.DuckDBParameter { Value = record.FormKey.ToString() });
        using var reader = cmd.ExecuteReader();

        Assert.True(reader.Read(), "Expected a document for the record.");
        Assert.Equal(CutDownPluginFixture.PluginFileName, reader.GetString(0));
        Assert.Equal("Data", reader.GetString(1));
        Assert.Equal("npc_", reader.GetString(2));
        Assert.Equal(record.EditorID, reader.GetString(3));
        Assert.Equal(0, reader.GetInt32(4));
        Assert.True(reader.GetBoolean(5), "The only plugin indexed should win its own records.");
        Assert.Equal(SourceRef.Committed, reader.GetString(6));
    }
}
