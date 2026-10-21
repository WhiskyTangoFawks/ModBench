using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Codec.Tests.Schema;

public sealed class LeafLabelTests
{
    [Theory]
    [InlineData("npc_", "Level", "NpcLevel", "Npc Level")]
    [InlineData("npc_", "Level", "PcLevelMult", "Pc Level Mult")]
    [InlineData("qust", "Aliases.[]", "QuestReferenceAlias", "Reference")]
    [InlineData("qust", "Aliases.[]", "QuestCollectionAlias", "Collection")]
    [InlineData("mgef", "Archetype", "MagicEffectBoundArchetype", "Bound")]
    public void AUnionsDiscriminatorLabelsALeaf_WithTheWordsItDoesNotShareWithTheBase(string table, string path, string leaf, string label)
    {
        var union = SchemaFields.At(GameRelease.Fallout4, table, path);

        var labels = union.Fields.Require().Single(member => member.Name == "MutagenObjectType").EnumMembers.ToDictionary(m => m.Value, m => m.Label);

        Assert.Equal(label, labels[leaf]);
    }
}
