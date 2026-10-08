using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Index.Tests.TestSupport;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Index.Tests.RealData;

[Collection(CutDownPluginCollection.Name)]
public sealed class AbstractUnionRealDataTests(CutDownPluginFixture fixture)
{
    private JsonElement? Field(string type, string editorId, string column)
    {
        var summary = fixture.Index.Records.GetRecords([type], CutDownPluginFixture.Plugin, editorId, limit: 1, offset: 0).Items.Single();
        return FieldOf(summary.FormKey, column);
    }

    private JsonElement? FieldOf(string formKey, string column) =>
        fixture.Index.DocumentOf(formKey, CutDownPluginFixture.Plugin).Fields.Single(f => f.Metadata.Name == column).Value as JsonElement?;

    [Fact]
    public void Level_EveryFixtureNpc_NamesItsLeafInTheDocument()
    {
        var npcs = fixture.Index.Records.GetRecords(["npc_"], CutDownPluginFixture.Plugin, search: null, limit: 5000, offset: 0).Items;
        Assert.NotEmpty(npcs);
        foreach (var npc in npcs)
        {
            var element = Assert.IsType<JsonElement>(FieldOf(npc.FormKey, "Level"));
            Assert.Equal(nameof(NpcLevel), element.GetProperty(LoquiUnions.UnionTypeDiscriminator).GetString());
        }
    }

    [Fact]
    public void Aliases_DialogueConcordArea_HasBothReferenceAndLocationAliasKinds()
    {
        var aliases = Assert.IsType<JsonElement>(Field("qust", "DialogueConcordArea", "Aliases"));
        var elements = aliases.EnumerateArray().ToList();
        Assert.NotEmpty(elements);

        var kinds = elements.Select(e => e.GetProperty(LoquiUnions.UnionTypeDiscriminator).GetString()).ToHashSet();
        Assert.Contains(nameof(QuestReferenceAlias), kinds);
        Assert.Contains(nameof(QuestLocationAlias), kinds);

        Assert.All(elements, e => Assert.False(string.IsNullOrEmpty(e.GetProperty(LoquiUnions.UnionTypeDiscriminator).GetString())));
    }
}
