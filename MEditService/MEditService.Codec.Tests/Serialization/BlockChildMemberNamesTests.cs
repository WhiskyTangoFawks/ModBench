using MEditService.Codec.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Tests.Serialization;

public sealed class BlockChildMemberNamesTests
{
    [Fact]
    public void ExteriorCellBlockLevels_AreAWorldspacesTwoBlockTypes_OutermostFirst() =>
        Assert.Equal(
            [typeof(WorldspaceBlock), typeof(WorldspaceSubBlock)],
            RecordTypeDispatch.For(GameRelease.Fallout4).ExteriorCellBlockLevels);

    [Fact]
    public void BlockNumberMembers_NameRealMembersOfBothBlockLevels()
    {
        Assert.NotNull(typeof(WorldspaceBlock).GetProperty(RecordTypeDispatch.BlockNumberXMember));
        Assert.NotNull(typeof(WorldspaceSubBlock).GetProperty(RecordTypeDispatch.BlockNumberYMember));
    }

    [Fact]
    public void InteriorCellBlockLevels_AreTheCellsGroupsTwoBlockTypes_OutermostFirst() =>
        Assert.Equal(
            [typeof(CellBlock), typeof(CellSubBlock)],
            RecordTypeDispatch.For(GameRelease.Fallout4).InteriorCellBlockLevels);

    [Fact]
    public void InteriorCellBlockGroupTypes_NameTheGroupTypesOfTheTwoInteriorLevels() =>
        Assert.Equal(
            [GroupTypeEnum.InteriorCellBlock, GroupTypeEnum.InteriorCellSubBlock],
            RecordTypeDispatch.InteriorCellBlockGroupTypes.Select(Enum.Parse<GroupTypeEnum>));

    [Fact]
    public void GroupTypeMember_NamesARealMemberOfABlockLevel() =>
        Assert.NotNull(typeof(CellBlock).GetProperty(RecordTypeDispatch.GroupTypeMember));

    [Fact]
    public void CellGridMember_NamesARealMemberOfACell() =>
        Assert.NotNull(typeof(Cell).GetProperty(RecordTypeDispatch.CellGridMember));
}
