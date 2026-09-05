using System.Reflection;
using MEditService.Core.Records;

namespace MEditService.Tests.Records;

/// <summary>Neither <see cref="IRecordIndex"/> implementer carries a one-line forwarding member for
/// an <c>IRecordReads</c> read. Reflection-derived so a new read member cannot silently reintroduce
/// the forwarding tax.</summary>
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

    // Name-based, not signature-based: a forward for a member IRecordReads still declares would collide
    // on name whatever the overload, and that reintroduction is what this catches.
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
