using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Codec.Tests.Schema;

public class AbstractUnionDiscriminatorMetadataTests
{
    [Fact]
    public void QuestAliasDiscriminator_IsAnEnumOverTheLeafClassNames()
    {
        var kind = SchemaFields.At(GameRelease.Fallout4, "qust", "Aliases.[].MutagenObjectType");

        Assert.Equal("enum", kind.Type);
        Assert.Equal(
            ["QuestReferenceAlias", "QuestLocationAlias", "QuestCollectionAlias"],
            kind.EnumMembers.Select(m => m.Value));
    }
}
