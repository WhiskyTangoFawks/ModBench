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
            .Select(row => fixture.Reads.GetDocument(row[0], CutDownPluginFixture.Plugin)?.Fields.FirstOrDefault(f => f.Metadata.Name == "Flags")?.Value)
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
            if (AnyColumnOf(table, schema.RecordColumns.Where(c => !c.IsViewable).Select(c => c.Name)))
                offenders.Add(table);
            if (AnyColumnOf(table, schema.RecordColumns.Where(c => c.IsViewable).Select(c => c.Name)))
                tablesWithScalars++;
        }

        Assert.Empty(offenders);
        Assert.True(tablesWithScalars > 0, "Positive control: viewable scalars must actually be reachable.");
    }

    [Fact]
    public void GrupTimestamps_AreAbsentFromTheSchemaAndTheViewAlike()
    {
        string[] timestamps = ["timestamp", "TemporaryTimestamp", "PersistentTimestamp"];

        foreach (var table in (string[])["cell", "dial", "qust"])
        {
            var schemaNames = Schemas[table].RecordColumns.Select(c => c.Name).ToHashSet(StringComparer.OrdinalIgnoreCase);
            Assert.True(
                AnyColumnOf(table, Schemas[table].RecordColumns.Where(c => c.IsViewable).Select(c => c.Name)),
                $"Positive control: {table} must carry real filterable columns.");

            foreach (var name in timestamps) Assert.DoesNotContain(name, schemaNames);
            Assert.False(AnyColumnOf(table, timestamps), $"{table}'s view carries a GRUP timestamp.");
        }
    }
}
