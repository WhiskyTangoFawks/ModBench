using MEditService.Codec.Schema;

namespace MEditService.Tests.Indexing;

public class LeafLabelTests
{
    [Theory]
    // The base's words, dropped from the head and the tail of the leaf's.
    [InlineData("AQuestAlias", "QuestReferenceAlias", "Reference")]
    [InlineData("AQuestAlias", "QuestCollectionAlias", "Collection")]
    [InlineData("AMagicEffectArchetype", "MagicEffectBoundArchetype", "Bound")]
    // A base that isn't spelled A<Name> keeps its whole name, so less is in common.
    [InlineData("OwnerTarget", "NpcOwner", "Npc Owner")]
    // A leaf that is its own base keeps its own name rather than emptying out.
    [InlineData("ANpcLevel", "NpcLevel", "Npc Level")]
    [InlineData("ANpcLevel", "PcLevelMult", "Pc Level Mult")]
    // A leaf with nothing in common with its base keeps all of its own words.
    [InlineData("ASomethingElse", "PerkQuestEffect", "Perk Quest Effect")]
    public void Labels(string abstractBaseName, string leafClassName, string expected) =>
        Assert.Equal(expected, LeafLabel.For(abstractBaseName, leafClassName));

    [Fact]
    public void KeepsAnAcronymWhole()
    {
        Assert.Equal("NPC Data", LeafLabel.For("AOwnerTarget", "NPCData"));
        // And an acronym is matched against the base as one word, like any other.
        Assert.Equal("Data", LeafLabel.For("ANPCTarget", "NPCData"));
    }
}
