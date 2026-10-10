using System.Text.Json;
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
    [InlineData("glob", "OutputChar", "BOOLEAN")]
    public void AViewColumn_HasTheSqlTypeOfItsLeaf(string table, string column, string expected)
    {
        Assert.Equal(expected, ViewColumnType(table, column));
    }

    [Fact]
    public void EveryRecordType_HasAView()
    {
        var unreachable = Schemas.Keys
            .Where(table => !fixture.Index.Accepts($"SELECT form_key FROM \"{table}\""))
            .ToList();

        Assert.NotEmpty(Schemas);
        Assert.Empty(unreachable);
    }

    [Fact]
    public void ANonNullableScalar_NeverReadsNullThroughItsView()
    {
        Assert.Contains(Schemas["npc_"].RecordColumns, c => c.Name == "XpValueOffset");

        Assert.True(fixture.Index.Matching("SELECT form_key FROM \"npc_\"") > 0, "Expected npc_ rows.");
        Assert.Equal(0, fixture.Index.Matching("SELECT form_key FROM \"npc_\" WHERE \"XpValueOffset\" IS NULL"));
    }

    [Fact]
    public void OmittedDefaults_ReadAsTheDefault_NotNull()
    {
        var absent = fixture.Index.Matching("SELECT form_key FROM records WHERE record_type = 'npc_' AND NOT json_exists(body, '$.CalcMinLevel')");

        Assert.True(absent > 0, "Positive control: some npc_ documents must omit CalcMinLevel for this to mean anything.");
        Assert.Equal(0, fixture.Index.Matching("SELECT form_key FROM \"npc_\" WHERE \"CalcMinLevel\" IS NULL"));
        Assert.Equal(absent, fixture.Index.Matching("SELECT form_key FROM \"npc_\" WHERE \"CalcMinLevel\" = 0"));
    }

    [Fact]
    public void TranslatedStrings_ReadTheirValue_NotTheEnvelope()
    {
        Assert.True(fixture.Index.Matching("SELECT form_key FROM \"acti\" WHERE \"Name\" IS NOT NULL") > 0,
            "Positive control: some acti record must carry a Name.");

        Assert.Equal(0, fixture.Index.Matching("SELECT form_key FROM \"acti\" WHERE \"Name\" LIKE '%TargetLanguage%'"));
    }

    [Fact]
    public void FlagsEnums_ReadAsJoinedNames_SoAFilterCanMatchOneWithLike()
    {
        var flagName = fixture.Index.Queries.GetRecords(["cell"], CutDownPluginFixture.Plugin, search: null, limit: 5000, offset: 0).Value().Items
            .Select(cell => fixture.Index.CopyIn(cell.FormKey, CutDownPluginFixture.Plugin)?.Fields.FirstOrDefault(f => f.Metadata.Name == "Flags")?.Value)
            .OfType<JsonElement>()
            .Where(value => value.ValueKind == JsonValueKind.Array && value.GetArrayLength() > 0)
            .Select(value => value[0].GetString())
            .First(name => !string.IsNullOrEmpty(name));

        Assert.True(fixture.Index.Matching($"SELECT form_key FROM \"cell\" WHERE \"Flags\" LIKE '%{flagName}%'") > 0,
            $"A flag name must be matchable with LIKE — that is the capability this rendering exists to keep, and '{flagName}' is a name the fixture carries.");

        Assert.Equal(0, fixture.Index.Matching("SELECT form_key FROM \"cell\" WHERE \"Flags\" LIKE '%[%' OR \"Flags\" LIKE '%\"%'"));
    }

    [Theory]
    [InlineData("npc_", "Factions")]
    [InlineData("npc_", "Weight")]
    public void AnArrayOrStructMember_HasNoViewColumn(string table, string column)
    {
        Assert.False(fixture.Index.Accepts($"SELECT form_key FROM \"{table}\" WHERE \"{column}\" IS NULL"));
    }
}
