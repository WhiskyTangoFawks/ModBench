using MEditService.Codec.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Codec.Tests.Serialization;

public sealed class BlockChildMemberNamesTests
{
    [Fact]
    public void ExteriorCellBlockLevels_AreAWorldspacesTwoBlockTypes_OutermostFirst() =>
        Assert.Equal(
            [nameof(WorldspaceBlock), nameof(WorldspaceSubBlock)],
            RecordTypes.For(GameRelease.Fallout4).ExteriorCellBlockLevels);

    [Fact]
    public void InteriorCellBlockLevels_AreTheCellsGroupsTwoBlockTypes_OutermostFirst() =>
        Assert.Equal(
            [nameof(CellBlock), nameof(CellSubBlock)],
            RecordTypes.For(GameRelease.Fallout4).InteriorCellBlockLevels);

    [Fact]
    public void InteriorCellBlockGroupTypes_NameTheGroupTypesOfTheTwoInteriorLevels() =>
        Assert.Equal(
            [GroupTypeEnum.InteriorCellBlock, GroupTypeEnum.InteriorCellSubBlock],
            RecordTypes.InteriorCellBlockGroupTypes.Select(Enum.Parse<GroupTypeEnum>));
}
