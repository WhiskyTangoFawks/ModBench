using MEditService.Core.Serialization;
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
}
