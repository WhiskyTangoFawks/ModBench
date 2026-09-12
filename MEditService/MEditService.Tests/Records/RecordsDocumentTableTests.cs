using System.Globalization;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Index;
using MEditService.SourceRepo;
using MEditService.Tests.RealData;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Order;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Records;

/// <summary>Through the SQL door, not <c>IRecordReads</c>: the relational schema is the contract for user
/// filter SQL, and a repository-only test would pass if the method compensated.</summary>
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

    [Fact]
    public void Index_WritesOneDocumentPerRecordOfEveryIndexedType()
    {
        using var overlay = OpenPlugin();
        // The header is excluded from the enumeration, a ModHeader not being an IMajorRecordGetter, and
        // added back as the one ordinary `records` row it contributes, so leaving it out would under-count
        // by exactly one per plugin.
        var expected = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4)
            .Where(kv => kv.Key != PluginHeader.RecordType)
            .Sum(kv => overlay.EnumerateMajorRecords(kv.Value.RecordType, throwIfUnknown: false).Count())
            + 1;

        var actual = Convert.ToInt64(Scalar("SELECT COUNT(*) FROM records"), CultureInfo.InvariantCulture);

        Assert.True(expected > 0, "The cut-down plugin should contain records of indexed types.");
        Assert.Equal(expected, actual);
    }

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

    [Fact]
    public void Index_ContentHash_IsTheRepositorysHashOfTheStoredBody()
    {
        using var cmd = _fixture.Repo.Connection.CreateCommand();
        cmd.CommandText = "SELECT form_key, body, content_hash FROM records";
        using var reader = cmd.ExecuteReader();

        var checked_ = 0;
        var mismatches = new List<string>();
        while (reader.Read())
        {
            var stored = reader.GetString(2);
            var recomputed = SourceRepository.ContentHash(System.Text.Encoding.UTF8.GetBytes(reader.GetString(1)));
            if (!string.Equals(stored, recomputed, StringComparison.Ordinal))
                mismatches.Add($"{reader.GetString(0)}: stored {stored} != {recomputed}");
            checked_++;
        }

        Assert.True(checked_ > 0, "Expected documents to check.");
        Assert.Empty(mismatches);
    }

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
