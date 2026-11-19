using System.Text;
using MEditService.Codec.Serialization;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Codec.Tests.Serialization;

public sealed class DocumentMeaningTests
{
    private static string? Difference(string held, string produced) =>
        DocumentMeaning.FirstDifference(Encoding.UTF8.GetBytes(held), Encoding.UTF8.GetBytes(produced));

    [Theory]
    [InlineData("""{"A":1,"B":2}""", """{ "B": 2, "A": 1 }""")]
    [InlineData("""{"A":[1,2]}""", "{\n  \"A\": [ 1, 2 ]\n}")]
    [InlineData("""{"A":2.5}""", """{"A":2.50}""")]
    [InlineData("""{"A":0.1}""", """{"A":0.10000000149011612}""")]
    public void TwoDocumentsOfOneMeaning_HaveNoDifference(string held, string produced)
    {
        Assert.Null(Difference(held, produced));
    }

    [Theory]
    [InlineData("""{"A":9007199254740993}""", """{"A":9007199254740992}""", "A")]
    [InlineData("""{"A":{"B":[1,2]}}""", """{"A":{"B":[2,1]}}""", "A.B[0]")]
    [InlineData("""{"A":1}""", """{"A":1,"B":2}""", "B")]
    [InlineData("""{"A":"1"}""", """{"A":1}""", "A")]
    [InlineData("not json", """{"A":1}""", "the document")]
    public void TwoDocumentsOfAnotherMeaning_NameTheFirstMemberThatDiffers(string held, string produced, string path)
    {
        Assert.Equal(path, Difference(held, produced));
    }

    private static string NpcText()
    {
        static FormKey Of(uint id) => new(ModKey.FromFileName("Fallout4.esm"), id);
        var npc = new Npc(new FormKey(ModKey.FromFileName("Meaning.esp"), 0x800), Fallout4Release.Fallout4)
        {
            EditorID = "Guy",
            Flags = Npc.Flag.Female | Npc.Flag.Essential,
            Keywords = [new FormLink<IKeywordGetter>(Of(0x11)), new FormLink<IKeywordGetter>(Of(0x12))],
            Factions =
            [
                new RankPlacement { Faction = new FormLink<IFactionGetter>(Of(0x13)), Rank = 0 },
                new RankPlacement { Faction = new FormLink<IFactionGetter>(Of(0x14)), Rank = 1 },
            ],
        };
        return RecordTextCodec.SerializeToText(npc, GameRelease.Fallout4);
    }

    private static string WithReversed(string text, string member) =>
        JsonReversal.WithReversed(text, root => root[member].Require().AsArray());

    private static string? NpcDifference(string held, string produced) =>
        DocumentMeaning.FirstDifference(Encoding.UTF8.GetBytes(held), Encoding.UTF8.GetBytes(produced), GameRelease.Fallout4, "npc_");

    [Theory]
    [InlineData("Factions")]
    [InlineData("Flags")]
    public void ARecordsDocumentHoldingAListWhoseOrderTheFormatDecides_InAnotherOrder_HasNoDifference(string member)
    {
        var produced = NpcText();

        Assert.Null(NpcDifference(WithReversed(produced, member), produced));
    }

    [Fact]
    public void ARecordsDocumentHoldingAListTheFormatKeepsInItsOrder_InAnotherOrder_DiffersAtThatList()
    {
        var produced = NpcText();

        Assert.Equal("Keywords[0]", NpcDifference(WithReversed(produced, "Keywords"), produced));
    }
}
