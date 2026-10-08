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
    public void BlockNumberMembers_NameRealMembersOfBothBlockLevels()
    {
        Assert.NotNull(typeof(WorldspaceBlock).GetProperty(RecordTypes.BlockNumberXMember));
        Assert.NotNull(typeof(WorldspaceSubBlock).GetProperty(RecordTypes.BlockNumberYMember));
    }

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

    [Fact]
    public void GroupTypeMember_NamesARealMemberOfABlockLevel() =>
        Assert.NotNull(typeof(CellBlock).GetProperty(RecordTypes.GroupTypeMember));

    [Fact]
    public void CellGridMember_NamesARealMemberOfACell() =>
        Assert.NotNull(typeof(Cell).GetProperty(RecordTypes.CellGridMember));
}
