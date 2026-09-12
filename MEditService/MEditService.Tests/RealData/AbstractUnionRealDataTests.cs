using System.Text.Json;
using MEditService.LoadOrder;
using MEditService.Index;
using MEditService.Codec.Schema;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.RealData;

/// <summary>Real records read through the index, where a union's document names the leaf each value
/// turned out to be. Quest aliases are the real overlay proof: Mutagen materializes
/// <c>Npc.Level</c> eagerly whatever the read mode.</summary>
public sealed class AbstractUnionRealDataTests(CutDownPluginFixture fixture) : IClassFixture<CutDownPluginFixture>
{
    private JsonElement? Field(string type, string editorId, string column)
    {
        var reads = fixture.Repo.At(RecordRef.Effective);
        var summary = reads.Search(new RecordQuery(RecordTypes: [type], Search: editorId, Limit: 1, Offset: 0)).Items.Single();
        var document = reads.GetDocument(summary.FormKey, new PluginKey(summary.Plugin, summary.Origin))!;
        return document.Fields.Single(f => f.Metadata.Name == column).Value as JsonElement?;
    }

    [Fact]
    public void Level_EveryFixtureNpc_NamesItsLeafInTheDocument()
    {
        var reads = fixture.Repo.At(RecordRef.Effective);
        var npcs = reads.Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 5000, Offset: 0)).Items;
        Assert.NotEmpty(npcs);
        foreach (var npc in npcs)
        {
            var level = reads.GetDocument(npc.FormKey, new PluginKey(npc.Plugin, npc.Origin))!
                .Fields.Single(f => f.Metadata.Name == "Level").Value;
            // Every real fixture NPC is NpcLevel today (verified — none is PcLevelMult), so this
            // pins the discriminator through a real binary-overlay-backed NPC without depending on
            // the one shape the fixture happens not to have.
            var element = Assert.IsType<JsonElement>(level);
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

        // Every element's own discriminator names a real leaf — never empty.
        Assert.All(elements, e => Assert.False(string.IsNullOrEmpty(e.GetProperty(LoquiUnions.UnionTypeDiscriminator).GetString())));
    }
}
