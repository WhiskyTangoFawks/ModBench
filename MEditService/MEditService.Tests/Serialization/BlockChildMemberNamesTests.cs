using MEditService.Core.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Tests.Serialization;

/// <summary>The block-nesting member names are string literals because their layer must not
/// name a game's types, so this buys back the compile-time check <c>nameof</c> would.</summary>
public sealed class BlockChildMemberNamesTests
{
    [Fact]
    public void SubBlockChildMember_NamesARealMemberOfTheSubBlockType() =>
        Assert.NotNull(typeof(CellSubBlock).GetProperty(
            RecordTypeDispatch.SubBlockChildMember));

    [Fact]
    public void BlockChildMember_NamesARealMemberOfTheBlockType() =>
        Assert.NotNull(typeof(CellBlock).GetProperty(
            RecordTypeDispatch.BlockChildMember));

    [Fact]
    public void TheTwoLevels_AreNotTheSameMember()
    {
        Assert.NotEqual(RecordTypeDispatch.BlockChildMember, RecordTypeDispatch.SubBlockChildMember);
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
    public void CellGridMember_NamesARealMemberOfACell() =>
        Assert.NotNull(typeof(Cell).GetProperty(RecordTypeDispatch.CellGridMember));

    // A block level whose own list element is itself. Mutagen's shape nests two levels and stops, so
    // only a synthetic type reaches the walk's own bound.
    private sealed class SelfNestingBlock
    {
        public List<SelfNestingBlock> Items { get; } = [];

        public short BlockNumberX { get; set; }
    }

    [Fact]
    public void BlockLevelsUnder_ABlockShapeThatNestsItself_YieldsThatLevelOnceAndStops() =>
        Assert.Equal([typeof(SelfNestingBlock)], RecordTypeDispatch.BlockLevelsUnder(typeof(SelfNestingBlock)));
}
