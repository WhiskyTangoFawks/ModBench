using MEditService.Codec.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Tests.Serialization;

/// <summary>The block-nesting member names are string literals because their layer must not
/// name a game's types, so this buys back the compile-time check <c>nameof</c> would.</summary>
public sealed class BlockChildMemberNamesTests
{
    // Mirror RecordTypeDispatch's own internal constants: string literals because that layer must
    // not name a game's types, and internal because no drawn caller needs them, only this guard.
    private const string SubBlockChildMember = "Cells";
    private const string BlockChildMember = "SubBlocks";
    private const string BlockNumberMember = "BlockNumber";

    [Fact]
    public void SubBlockChildMember_NamesARealMemberOfTheSubBlockType() =>
        Assert.NotNull(typeof(CellSubBlock).GetProperty(SubBlockChildMember));

    [Fact]
    public void BlockChildMember_NamesARealMemberOfTheBlockType() =>
        Assert.NotNull(typeof(CellBlock).GetProperty(BlockChildMember));

    [Fact]
    public void TheTwoLevels_AreNotTheSameMember()
    {
        Assert.NotEqual(BlockChildMember, SubBlockChildMember);
    }

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
    public void BlockNumberMember_NamesARealMemberOfBothInteriorLevels()
    {
        Assert.NotNull(typeof(CellBlock).GetProperty(BlockNumberMember));
        Assert.NotNull(typeof(CellSubBlock).GetProperty(BlockNumberMember));
    }

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
