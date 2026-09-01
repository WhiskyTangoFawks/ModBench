using System.Reflection;
using MEditService.Core.Records;

namespace MEditService.Tests.Records;

/// <summary>
/// #639: <see cref="IRecordIndex"/> no longer inherits <see cref="IRecordReads"/>, and neither
/// concrete implementer (<see cref="DuckDbRecordIndex"/>, the production one; <c>DelegatingRecordIndex</c>,
/// the test double) carries a pure one-line forwarding member for any <see cref="IRecordReads"/> read
/// — that forwarding tax (paid twice, once per implementer, for every read member) is exactly what
/// this ticket deletes.
///
/// Reflection-derived rather than a hand-typed member list, so a future <see cref="IRecordReads"/>
/// addition can't silently reintroduce the tax this ticket removes: this test would catch a new
/// one-line <c>At(RecordRef.Effective)</c> forward the moment one is added, not just the 18 members
/// #639 itself removed.
/// </summary>
public sealed class RecordIndexSurfaceTests
{
    [Fact]
    public void IRecordIndex_DoesNotInheritIRecordReads() =>
        Assert.DoesNotContain(typeof(IRecordReads), typeof(IRecordIndex).GetInterfaces());

    [Fact]
    public void DuckDbRecordIndex_DeclaresNoIRecordReadsForwards() =>
        AssertNoForwardingMembers(typeof(DuckDbRecordIndex));

    [Fact]
    public void DelegatingRecordIndex_DeclaresNoIRecordReadsForwards() =>
        AssertNoForwardingMembers(typeof(DelegatingRecordIndex));

    // Name-based, not signature-based: a forward for a member IRecordReads still declares would
    // collide on name with the real member regardless of exact overload, and this is meant to
    // catch exactly that reintroduction — not to police unrelated same-named methods, of which
    // this pair has none today.
    private static void AssertNoForwardingMembers(Type concreteType)
    {
        var readsMemberNames = typeof(IRecordReads)
            .GetMethods(BindingFlags.Public | BindingFlags.Instance)
            .Select(m => m.Name)
            .ToHashSet(StringComparer.Ordinal);

        var declaredNames = concreteType
            .GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly)
            .Select(m => m.Name)
            .ToHashSet(StringComparer.Ordinal);

        Assert.Empty(declaredNames.Intersect(readsMemberNames));
    }
}
