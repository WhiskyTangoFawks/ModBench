using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Index.Tests.TestSupport;
using MEditService.Tests;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Index.Tests.Indexing;

/// <summary>ADR-0011: the per-type relations are the contract for user filter SQL, so they are
/// asked through the filter door over real game data rather than against literals.</summary>
public sealed class GeneratedViewTests(CutDownPluginFixture fixture) : IClassFixture<CutDownPluginFixture>
{
    private static IReadOnlyDictionary<string, RecordTableSchema> Schemas =>
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);

    private int Matching(string sql) => fixture.Index.Matching(sql);

    // One filter per table rather than per column: SetFilter re-materializes the whole match set,
    // and there are thousands of columns.
    private bool AnyColumnOf(string table, IEnumerable<string> columns)
    {
        var names = columns.Select(c => $"'{c}'").ToList();
        return names.Count != 0 && Matching($"""
            SELECT form_key FROM records WHERE EXISTS (
                SELECT 1 FROM duckdb_columns()
                WHERE table_name = '{table}' AND column_name IN ({string.Join(", ", names)}))
            """) > 0;
    }

    [Fact]
    public void EveryRecordType_IsNameableInAFilter()
    {
        var unreachable = Schemas.Keys
            .Where(table => !fixture.Index.Accepts($"SELECT form_key FROM \"{table}\""))
            .ToList();

        Assert.NotEmpty(Schemas);
        Assert.Empty(unreachable);
    }

    [Fact]
    public void ANonNullableScalar_NeverReadsNullThroughTheFilter()
    {
        Assert.Contains(Schemas["npc_"].RecordColumns, c => c.Name == "XpValueOffset");

        Assert.True(Matching("SELECT form_key FROM \"npc_\"") > 0, "Expected npc_ rows.");
        Assert.Equal(0, Matching("SELECT form_key FROM \"npc_\" WHERE \"XpValueOffset\" IS NULL"));
    }

    [Fact]
    public void OmittedDefaults_ReadAsTheDefault_NotNull()
    {
        var absent = fixture.Reads.GetDocuments(CutDownPluginFixture.Plugin)
            .Where(d => d.RecordType == "npc_")
            .Count(d => !JsonDocument.Parse(d.Body ?? "{}").RootElement.TryGetProperty("CalcMinLevel", out _));

        Assert.True(absent > 0, "Positive control: some npc_ documents must omit CalcMinLevel for this to mean anything.");
        Assert.Equal(0, Matching("SELECT form_key FROM \"npc_\" WHERE \"CalcMinLevel\" IS NULL"));
        Assert.Equal(absent, Matching("SELECT form_key FROM \"npc_\" WHERE \"CalcMinLevel\" = 0"));
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
        // Taken off a document rather than written down: the curated slice is regenerable, and a
        // flag it stops carrying would turn the LIKE below into a match against nothing.
        var flagName = fixture.Reads.GetDocuments(CutDownPluginFixture.Plugin)
            .Where(d => d.RecordType == "cell")
            .Select(d => d.Fields.FirstOrDefault(f => f.Metadata.Name == "Flags")?.Value)
            .OfType<JsonElement>()
            .Where(value => value.ValueKind == JsonValueKind.Array && value.GetArrayLength() > 0)
            .Select(value => value[0].GetString())
            .First(name => !string.IsNullOrEmpty(name));

        Assert.True(Matching($"SELECT form_key FROM \"cell\" WHERE \"Flags\" LIKE '%{flagName}%'") > 0,
            $"A flag name must be matchable with LIKE — that is the capability this rendering exists to keep, and '{flagName}' is a name the fixture carries.");

        // A JSON array rendering would carry brackets and quotes, and LIKE on a flag name would
        // then depend on the punctuation around it.
        Assert.Equal(0, Matching("SELECT form_key FROM \"cell\" WHERE \"Flags\" LIKE '%[%' OR \"Flags\" LIKE '%\"%'"));
    }

    [Fact]
    public void AFilterNamesEveryViewableScalar_AndNoArrayStructOrClassVaryingColumn()
    {
        var offenders = new List<string>();
        var tablesWithScalars = 0;
        foreach (var (table, schema) in Schemas)
        {
            if (AnyColumnOf(table, schema.RecordColumns.Where(c => !c.IsViewable).Select(c => c.Name)))
                offenders.Add(table);
            if (AnyColumnOf(table, schema.RecordColumns.Where(c => c.IsViewable).Select(c => c.Name)))
                tablesWithScalars++;
        }

        Assert.Empty(offenders);
        Assert.True(tablesWithScalars > 0, "Positive control: viewable scalars must actually be reachable.");
    }

    [Fact]
    public void GrupTimestamps_AreAbsentFromTheSchemaAndTheFilterAlike()
    {
        string[] timestamps = ["timestamp", "TemporaryTimestamp", "PersistentTimestamp"];

        foreach (var table in (string[])["cell", "dial", "qust"])
        {
            var schemaNames = Schemas[table].RecordColumns.Select(c => c.Name).ToHashSet(StringComparer.OrdinalIgnoreCase);
            Assert.True(
                AnyColumnOf(table, Schemas[table].RecordColumns.Where(c => c.IsViewable).Select(c => c.Name)),
                $"Positive control: {table} must carry real filterable columns.");

            foreach (var name in timestamps) Assert.DoesNotContain(name, schemaNames);
            Assert.False(AnyColumnOf(table, timestamps), $"{table} names a GRUP timestamp in a filter.");
        }
    }
}
