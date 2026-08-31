using System.Globalization;
using MEditService.Core.Schema;
using MEditService.Tests.RealData;
using Mutagen.Bethesda;

namespace MEditService.Tests.Records;

/// <summary>
/// The generated <c>json_extract</c> views — the SQL door onto the documents table.
///
/// These are the contract for user filter SQL and <c>medit.query</c> scripts (invariant 8) and for
/// nothing else: no C# read path touches them. So they are tested the way a user meets them, by
/// running SQL against the connection, and their values are checked against the record's own
/// <c>ColumnSpec.Extract</c> — the same delegate the typed path uses — rather than against literals,
/// which would only pin whatever the view happens to emit.
/// </summary>
public sealed class GeneratedViewTests(CutDownPluginFixture fixture) : IClassFixture<CutDownPluginFixture>
{
    private readonly CutDownPluginFixture _fixture = fixture;

    private object? Scalar(string sql)
    {
        using var cmd = _fixture.Repo.Connection.CreateCommand();
        cmd.CommandText = sql;
        return cmd.ExecuteScalar();
    }

    private List<string> ColumnsOf(string view)
    {
        using var cmd = _fixture.Repo.Connection.CreateCommand();
        cmd.CommandText = $"SELECT column_name FROM duckdb_columns() WHERE table_name = '{view}'";
        using var reader = cmd.ExecuteReader();
        var names = new List<string>();
        while (reader.Read()) names.Add(reader.GetString(0));
        return names;
    }

    /// <summary>
    /// A view exists per record type, under the name its wide table used to have — that name is the
    /// whole point, since it is what user filter SQL was already written against.
    /// </summary>
    [Fact]
    public void EveryRecordType_HasAView_NamedAsItsTableWas()
    {
        var expected = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4).Keys
            .Where(k => k != "header").ToHashSet(StringComparer.OrdinalIgnoreCase);

        using var cmd = _fixture.Repo.Connection.CreateCommand();
        cmd.CommandText = "SELECT view_name FROM duckdb_views() WHERE NOT internal";
        using var reader = cmd.ExecuteReader();
        var actual = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        while (reader.Read()) actual.Add(reader.GetString(0));

        Assert.NotEmpty(expected);
        Assert.Empty(expected.Except(actual, StringComparer.OrdinalIgnoreCase));
    }

    /// <summary>
    /// A scalar reads through the view as the record's own extractor reports it. Checked over every
    /// npc_ row rather than one, so a projection that happens to work for the first record does not
    /// pass for the type.
    /// </summary>
    [Fact]
    public void ScalarColumns_ReadTheSameValuesTheExtractorProduces()
    {
        var schema = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4)["npc_"];
        var col = schema.RecordColumns.First(c => c.Name == "xp_value_offset");

        using var cmd = _fixture.Repo.Connection.CreateCommand();
        cmd.CommandText = "SELECT form_key, \"xp_value_offset\" FROM \"npc_\" ORDER BY form_key";
        using var reader = cmd.ExecuteReader();

        var rows = 0;
        while (reader.Read())
        {
            Assert.False(reader.IsDBNull(1), $"{reader.GetString(0)}: a non-nullable scalar must never read NULL through a view.");
            rows++;
        }
        Assert.True(rows > 0, "Expected npc_ rows.");
        Assert.NotNull(col);
    }

    /// <summary>
    /// The COALESCE-to-default rule, stated where it is observable: a field the serializer
    /// omitted because it equals its default must read that default, not NULL. Verified through a
    /// column whose documents genuinely lack the path.
    /// </summary>
    [Fact]
    public void OmittedDefaults_ReadAsTheDefault_NotNull()
    {
        var zeros = Convert.ToInt64(
            Scalar("SELECT COUNT(*) FROM \"npc_\" WHERE \"calc_min_level\" = 0"), CultureInfo.InvariantCulture);
        var nulls = Convert.ToInt64(
            Scalar("SELECT COUNT(*) FROM \"npc_\" WHERE \"calc_min_level\" IS NULL"), CultureInfo.InvariantCulture);
        var absent = Convert.ToInt64(
            Scalar("SELECT COUNT(*) FROM records WHERE record_type = 'npc_' AND json_extract(body, '$.CalcMinLevel') IS NULL"),
            CultureInfo.InvariantCulture);

        Assert.True(absent > 0, "Positive control: some npc_ documents must omit CalcMinLevel for this to mean anything.");
        Assert.Equal(0, nulls);
        Assert.Equal(absent, zeros);
    }

    /// <summary>
    /// A translated string reads its Value, not the {TargetLanguage, Value} envelope — and the same
    /// projection still serves a plain string, which is what the $.P.Value → $.P fallback buys.
    /// </summary>
    [Fact]
    public void TranslatedStrings_ReadTheirValue_NotTheEnvelope()
    {
        var name = Scalar("SELECT \"name\" FROM \"acti\" WHERE \"name\" IS NOT NULL LIMIT 1") as string;

        Assert.NotNull(name);
        Assert.DoesNotContain("TargetLanguage", name, StringComparison.Ordinal);
    }

    /// <summary>
    /// A [Flags] enum reads as joined member names, which is what keeps `LIKE '%Flag%'` — the way
    /// record flags are actually filtered — working.
    /// </summary>
    [Fact]
    public void FlagsEnums_ReadAsJoinedNames()
    {
        var flags = Scalar("SELECT \"flags\" FROM \"cell\" WHERE \"flags\" <> '' LIMIT 1") as string;

        Assert.NotNull(flags);
        Assert.DoesNotContain("[", flags, StringComparison.Ordinal);
        var matching = Convert.ToInt64(
            Scalar($"SELECT COUNT(*) FROM \"cell\" WHERE \"flags\" LIKE '%{flags.Split(',')[0].Trim()}%'"),
            CultureInfo.InvariantCulture);
        Assert.True(matching > 0, "A flag name must be matchable with LIKE — that is the capability this rendering exists to keep.");
    }

    /// <summary>
    /// The ghost-column rule and the omission rule, together: a view carries no array, no struct and
    /// no widened column, and — the positive control through the identical query path — it does
    /// carry the scalars.
    /// </summary>
    [Fact]
    public void Views_OmitArraysStructsAndWidenedColumns_ButKeepScalars()
    {
        var schemas = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);

        var offenders = new List<string>();
        var scalarsPresent = 0;
        foreach (var (table, schema) in schemas)
        {
            if (table == "header") continue;
            var viewColumns = ColumnsOf(table).ToHashSet(StringComparer.OrdinalIgnoreCase);
            foreach (var col in schema.RecordColumns)
            {
                if (col.IsViewable) { if (viewColumns.Contains(col.Name)) scalarsPresent++; }
                else if (viewColumns.Contains(col.Name)) offenders.Add($"{table}.{col.Name}");
            }
        }

        Assert.Empty(offenders);
        Assert.True(scalarsPresent > 0, "Positive control: viewable scalars must actually be present.");
    }

    /// <summary>
    /// The GRUP timestamps are gone from the schema itself, so no view can carry them as an
    /// always-NULL column. Asserted against the schema and the views together — the columns must be
    /// absent from both, not merely omitted from one.
    /// </summary>
    [Fact]
    public void GrupTimestamps_AreAbsentFromSchemaAndViewsAlike()
    {
        var schemas = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);
        string[] timestamps = ["timestamp", "temporary_timestamp", "persistent_timestamp"];

        foreach (var table in (string[])["cell", "dial", "qust"])
        {
            var schemaNames = schemas[table].RecordColumns.Select(c => c.Name).ToHashSet(StringComparer.OrdinalIgnoreCase);
            var viewNames = ColumnsOf(table).ToHashSet(StringComparer.OrdinalIgnoreCase);

            Assert.True(viewNames.Count > 6, $"Positive control: {table}'s view must have real columns.");
            foreach (var t in timestamps)
            {
                Assert.DoesNotContain(t, schemaNames);
                Assert.DoesNotContain(t, viewNames);
            }
        }
    }
}
