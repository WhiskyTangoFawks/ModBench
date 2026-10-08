using System.Text.Json;
using System.Text.RegularExpressions;
using DuckDB.NET.Data;
using MEditService.Codec.Schema;
using MEditService.Index.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Index.Tests.Indexing;

[Collection(CutDownPluginCollection.Name)]
public sealed class GeneratedViewTests(CutDownPluginFixture fixture)
{
    private static IReadOnlyDictionary<string, RecordTableSchema> Schemas =>
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);

    private int Matching(string sql) => IndexFiles.Rows(fixture.InstanceRoot, sql).Count;

    private bool Binds(string sql)
    {
        try
        {
            IndexFiles.Rows(fixture.InstanceRoot, sql);
            return true;
        }
        catch (DuckDBException)
        {
            return false;
        }
    }

    private bool AnyColumnOf(string table, IEnumerable<string> columns)
    {
        var names = columns.Select(Regex.Escape).ToList();
        return names.Count != 0 && Binds($"""
            SELECT form_key FROM "{table}" WHERE EXISTS (SELECT COLUMNS('^({string.Join("|", names)})$') FROM "{table}")
            """);
    }

    private static bool IsScalar(ColumnSpec column) =>
        !column.Field.IsArray && column.Field.Fields == null && column.Synthetic == null
        && (column.Field.Variants == null || column.Field.Variants.Values.Select(v => v.Type).Distinct(StringComparer.Ordinal).Count() == 1);

    private string ViewColumnType(string table, string column) =>
        IndexFiles.Rows(fixture.InstanceRoot,
            $"SELECT data_type FROM information_schema.columns WHERE table_name = '{table}' AND column_name = '{column}'")
            .Single()[0];

    [Theory]
    [InlineData("npc_", "AggroRadiusBehaviorEnabled", "BOOLEAN")]
    [InlineData("npc_", "XpValueOffset", "BIGINT")]
    [InlineData("imad", "Unknown", "BIGINT")]
    [InlineData("npc_", "HeightMin", "FLOAT")]
    [InlineData("npc_", "Aggression", "VARCHAR")]
    [InlineData("npc_", "Flags", "VARCHAR")]
    [InlineData("npc_", "Race", "VARCHAR")]
    [InlineData("ligh", "Color", "VARCHAR")]
    [InlineData("header", "Author", "VARCHAR")]
    [InlineData("weap", "VersionControl", "BIGINT")]
    public void AViewColumn_HasTheSqlTypeOfItsLeaf(string table, string column, string expected)
    {
        Assert.Equal(expected, ViewColumnType(table, column));
    }

    [Fact]
    public void EveryRecordType_HasAView()
    {
        var unreachable = Schemas.Keys
            .Where(table => !Binds($"SELECT form_key FROM \"{table}\""))
            .ToList();

        Assert.NotEmpty(Schemas);
        Assert.Empty(unreachable);
    }

    [Fact]
    public void ANonNullableScalar_NeverReadsNullThroughItsView()
    {
        Assert.Contains(Schemas["npc_"].RecordColumns, c => c.Name == "XpValueOffset");

        Assert.True(Matching("SELECT form_key FROM \"npc_\"") > 0, "Expected npc_ rows.");
        Assert.Equal(0, Matching("SELECT form_key FROM \"npc_\" WHERE \"XpValueOffset\" IS NULL"));
    }

    [Fact]
    public void OmittedDefaults_ReadAsTheDefault_NotNull()
    {
        var absent = IndexFiles.Rows(fixture.InstanceRoot, "SELECT body FROM records WHERE record_type = 'npc_'")
            .Count(row => !JsonDocument.Parse(row[0]).RootElement.TryGetProperty("CalcMinLevel", out _));

        Assert.True(absent > 0, "Positive control: some npc_ documents must omit CalcMinLevel for this to mean anything.");
        Assert.Equal(0, Matching("SELECT form_key FROM \"npc_\" WHERE \"CalcMinLevel\" IS NULL"));
        Assert.Equal(absent, Matching("SELECT form_key FROM \"npc_\" WHERE \"CalcMinLevel\" = 0"));
    }

    [Theory]
    [InlineData("dial", "Priority", "50")]
    [InlineData("npc_", "AggroRadiusBehaviorEnabled", "false")]
    [InlineData("npc_", "Aggression", "'Unaggressive'")]
    [InlineData("npc_", "Flags", "''")]
    public void AnOmittedMember_ReadsAsItsDeclaredDefault_NotNull(string table, string column, string defaultLiteral)
    {
        var absent = IndexFiles.Rows(fixture.InstanceRoot, $"SELECT body FROM records WHERE record_type = '{table}'")
            .Count(row => !JsonDocument.Parse(row[0]).RootElement.TryGetProperty(column, out _));

        Assert.True(absent > 0, "Positive control: some document must omit the member for this to mean anything.");
        Assert.Equal(0, Matching($"SELECT form_key FROM \"{table}\" WHERE \"{column}\" IS NULL"));
        Assert.True(Matching($"SELECT form_key FROM \"{table}\" WHERE \"{column}\" IS NOT DISTINCT FROM {defaultLiteral}") >= absent);
    }

    [Fact]
    public void AColumnAbsentMeansNull_ReadsNullWhereTheDocumentOmitsIt()
    {
        var checkedColumns = 0;
        var offenders = new List<string>();
        foreach (var (table, schema) in Schemas)
        {
            var filled = schema.RecordColumns
                .Where(c => c.AbsentIsNull && IsScalar(c) && !c.Field.IsEditorId)
                .Select(c => $"(json_extract(r.body, '$.{c.PropertyName}') IS NULL AND v.\"{c.Name}\" IS NOT NULL)")
                .ToList();
            if (filled.Count == 0) continue;
            checkedColumns += filled.Count;
            if (Matching($"""
                SELECT v.form_key FROM "{table}" v
                JOIN records r ON r.form_key = v.form_key AND r.plugin = v.plugin AND r.origin = v.origin
                WHERE {string.Join(" OR ", filled)}
                """) > 0)
                offenders.Add(table);
        }

        Assert.True(checkedColumns > 0, "Positive control: some column must read null when absent.");
        Assert.Empty(offenders);
    }

    [Fact]
    public void TranslatedStrings_ReadTheirValue_NotTheEnvelope()
    {
        Assert.True(Matching("SELECT form_key FROM \"acti\" WHERE \"Name\" IS NOT NULL") > 0,
            "Positive control: some acti record must carry a Name.");

        Assert.Equal(0, Matching("SELECT form_key FROM \"acti\" WHERE \"Name\" LIKE '%TargetLanguage%'"));
    }

    [Fact]
    public void FlagsEnums_ReadAsJoinedNames_SoAFilterCanMatchOneWithLike()
    {
        var flagName = IndexFiles.Rows(fixture.InstanceRoot, "SELECT form_key FROM cell")
            .Select(row => fixture.Index.CopyIn(row[0], CutDownPluginFixture.Plugin)?.Fields.FirstOrDefault(f => f.Metadata.Name == "Flags")?.Value)
            .OfType<JsonElement>()
            .Where(value => value.ValueKind == JsonValueKind.Array && value.GetArrayLength() > 0)
            .Select(value => value[0].GetString())
            .First(name => !string.IsNullOrEmpty(name));

        Assert.True(Matching($"SELECT form_key FROM \"cell\" WHERE \"Flags\" LIKE '%{flagName}%'") > 0,
            $"A flag name must be matchable with LIKE — that is the capability this rendering exists to keep, and '{flagName}' is a name the fixture carries.");

        Assert.Equal(0, Matching("SELECT form_key FROM \"cell\" WHERE \"Flags\" LIKE '%[%' OR \"Flags\" LIKE '%\"%'"));
    }

    [Fact]
    public void AViewCarriesEveryViewableScalar_AndNoArrayStructOrClassVaryingColumn()
    {
        var offenders = new List<string>();
        var tablesWithScalars = 0;
        foreach (var (table, schema) in Schemas)
        {
            if (AnyColumnOf(table, schema.RecordColumns.Where(c => !IsScalar(c)).Select(c => c.Name)))
                offenders.Add(table);
            if (AnyColumnOf(table, schema.RecordColumns.Where(IsScalar).Select(c => c.Name)))
                tablesWithScalars++;
        }

        Assert.Empty(offenders);
        Assert.True(tablesWithScalars > 0, "Positive control: viewable scalars must actually be reachable.");
    }
}
