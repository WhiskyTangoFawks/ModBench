using MEditService.Core.Serialization;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Tests.Serialization;

/// <summary>
/// The two block-nesting member names <see cref="RecordTypeDispatch"/> hands out are string literals,
/// because the layer that owns them must not name a game's types (root CLAUDE.md: generalize across
/// Bethesda games). Literals can drift from the model in a way <c>nameof</c> cannot, so this is what
/// buys back the compile-time check the literals gave up.
///
/// <para>Fallout 4 is the fixture here, not the scope — the same members carry the same names in
/// Skyrim and Starfield, which is precisely why one literal can serve every game.</para>
/// </summary>
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

    /// <summary>They are different levels of the same nesting, so naming the same member would mean
    /// one of them is wrong.</summary>
    [Fact]
    public void TheTwoLevels_AreNotTheSameMember()
    {
        Assert.NotEqual(RecordTypeDispatch.BlockChildMember, RecordTypeDispatch.SubBlockChildMember);
    }
}
