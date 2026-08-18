using MEditService.Core.Ledger;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Ledger;

/// <summary>
/// #373 review (mutation axis): <see cref="ConcreteRecordTypeResolver"/> was extracted out of
/// <c>EditOrchestrator</c> this ticket and had no direct coverage of its own — every existing
/// exercise of it went through a real record type on a real ledger write, never its own boundary
/// (too-short a name, wrong prefix/suffix, a shape that resolves to nothing). Fixture-free by
/// design: a pure string transform plus a type lookup, no session/plugin/git needed. The two dummy
/// interfaces below exist purely to name shapes no real Mutagen type happens to have (a
/// correctly-shaped name with no matching concrete class; a name right at the length boundary) —
/// this file's own assembly is deliberately not <c>Mutagen.Bethesda.Fallout4</c>, so
/// <see cref="ConcreteRecordTypeResolver.Resolve"/> can never accidentally find a real match for
/// them.
/// </summary>
public sealed class ConcreteRecordTypeResolverTests
{
    // A name this file defines purely to be shaped like "I&lt;Something&gt;Getter" with no
    // matching Mutagen.Bethesda.Fallout4 concrete type behind it.
    private interface IWidgetGetter;

    // Exactly Prefix.Length + Suffix.Length ("I" + "Getter") characters — the boundary
    // ConcreteRecordTypeResolver.Resolve's own length guard rejects before ever attempting a
    // Type.GetType lookup, which real Mutagen getter names are never short enough to exercise.
    private interface IGetter;

    [Fact]
    public void Resolve_RealGetterInterface_ReturnsItsConcreteType()
    {
        Assert.Equal(typeof(Npc), ConcreteRecordTypeResolver.Resolve(typeof(INpcGetter)));
    }

    [Fact]
    public void Resolve_AnotherRealGetterInterface_ReturnsItsOwnConcreteType()
    {
        Assert.Equal(typeof(Keyword), ConcreteRecordTypeResolver.Resolve(typeof(IKeywordGetter)));
    }

    [Fact]
    public void Resolve_TypeNotStartingWithI_ReturnsNull()
    {
        Assert.Null(ConcreteRecordTypeResolver.Resolve(typeof(Npc))); // "Npc" — no "I" prefix at all
    }

    [Fact]
    public void Resolve_TypeNotEndingWithGetter_ReturnsNull()
    {
        Assert.Null(ConcreteRecordTypeResolver.Resolve(typeof(IMajorRecord))); // starts with "I", not "...Getter"
    }

    [Fact]
    public void Resolve_ShapedLikeAGetterButNoMatchingConcreteType_ReturnsNull()
    {
        Assert.Null(ConcreteRecordTypeResolver.Resolve(typeof(IWidgetGetter)));
    }

    [Fact]
    public void Resolve_NameAtTheLengthBoundary_ReturnsNullWithoutAttemptingALookup()
    {
        Assert.Null(ConcreteRecordTypeResolver.Resolve(typeof(IGetter)));
    }
}
