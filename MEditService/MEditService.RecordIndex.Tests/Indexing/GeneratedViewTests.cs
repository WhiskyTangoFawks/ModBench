using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Tests.Indexing;

[Collection(CutDownPluginCollection.Name)]
public sealed class GeneratedViewTests(CutDownPluginFixture fixture)
{
    private static IReadOnlyDictionary<string, RecordTableSchema> Schemas =>
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);

    private JsonElement[] Selected(string sql) => fixture.Index.Queries.SelectRows(sql).Value().Rows;

    private int Matching(string sql) => Selected(sql).Length;

    private bool Binds(string sql) => fixture.Index.Queries.SelectRows(sql).Holds(out _, out _);

    private string[] ViewColumnTypes(string table, string column) =>
        [.. Selected($"SELECT data_type FROM view_columns WHERE view_name = '{table}' AND column_name = '{column}'")
            .Select(row => row.GetProperty("data_type").GetString().Require())];

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
        Assert.Equal([expected], ViewColumnTypes(table, column));
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
    public void TranslatedStrings_ReadTheirValue_NotTheEnvelope()
    {
        Assert.True(Matching("SELECT form_key FROM \"acti\" WHERE \"Name\" IS NOT NULL") > 0,
            "Positive control: some acti record must carry a Name.");

        Assert.Equal(0, Matching("SELECT form_key FROM \"acti\" WHERE \"Name\" LIKE '%TargetLanguage%'"));
    }

    [Fact]
    public void FlagsEnums_ReadAsJoinedNames_SoAFilterCanMatchOneWithLike()
    {
        var flagName = Selected("SELECT form_key FROM cell")
            .Select(row => fixture.Index.CopyIn(row.GetProperty("form_key").GetString().Require(), CutDownPluginFixture.Plugin)?.Fields.FirstOrDefault(f => f.Metadata.Name == "Flags")?.Value)
            .OfType<JsonElement>()
            .Where(value => value.ValueKind == JsonValueKind.Array && value.GetArrayLength() > 0)
            .Select(value => value[0].GetString())
            .First(name => !string.IsNullOrEmpty(name));

        Assert.True(Matching($"SELECT form_key FROM \"cell\" WHERE \"Flags\" LIKE '%{flagName}%'") > 0,
            $"A flag name must be matchable with LIKE — that is the capability this rendering exists to keep, and '{flagName}' is a name the fixture carries.");

        Assert.Equal(0, Matching("SELECT form_key FROM \"cell\" WHERE \"Flags\" LIKE '%[%' OR \"Flags\" LIKE '%\"%'"));
    }

    [Theory]
    [InlineData("npc_", "Factions")]
    [InlineData("npc_", "Weight")]
    public void AnArrayOrStructMember_HasNoViewColumn(string table, string column)
    {
        Assert.Empty(ViewColumnTypes(table, column));
    }
}
