using System.Reflection;
using MEditService.Core.Schema;
using Mutagen.Bethesda;

namespace MEditService.Tests.Indexing;

/// <summary>Since <see cref="LeafWrite{TTarget}"/>, a null Apply cannot be spelled, so the assertion is the
/// inverse a type cannot make: a writable shape must not be declared read-only.</summary>
public class SchemaReflectorWriteSymmetryTests
{
    private static IReadOnlyList<SchemaReflector.LeafWriteFact> Facts() =>
        SharedSchemaReflector.Instance.EnumerateWriteCapability(GameRelease.Fallout4);

    private static bool IsWritableShaped(Type getterInterface)
    {
        var registration = getterInterface
            .GetProperty("StaticRegistration", BindingFlags.Public | BindingFlags.Static)?.GetValue(null);
        var setter = registration?.GetType()
            .GetField("ClassType", BindingFlags.Public | BindingFlags.Static)?.GetValue(null) as Type;
        return setter is { IsAbstract: false };
    }

    [Fact]
    public void NoWritableShapedNestedStruct_IsDeclaredReadOnly()
    {
        var lies = Facts()
            .Where(f => f.ReadOnlyReason != null)
            .Where(f => f.StructGetterType != null && IsWritableShaped(f.StructGetterType))
            .Select(f => $"{f.Path} ({f.StructGetterType!.Name}) — declared read-only: \"{f.ReadOnlyReason}\"")
            .Order(StringComparer.Ordinal)
            .ToList();

        Assert.True(lies.Count == 0,
            $"{lies.Count} leaf/leaves whose shape is writable are declared read-only. A resolvable, " +
            "non-abstract Loqui setter class exists for each, so a write could construct and set it — " +
            "declaring it read-only hides a capability rather than describing one. This is what a " +
            "reverted nested-struct write path looks like.\n  " + string.Join("\n  ", lies));
    }

    [Fact]
    public void EveryReadOnlyReason_ComesFromTheDeclaredVocabulary()
    {
        var known = new[]
        {
            SchemaRefusals.DiscriminatorReason,
            SchemaRefusals.ElementTemplateReason,
            SchemaRefusals.UnconvertibleElementListReason,
            SchemaRefusals.NoConverterReason,
            SchemaRefusals.HeaderNoWritePathReason,
        };

        var unknown = Facts()
            .Select(f => f.ReadOnlyReason)
            .Where(r => r != null)
            .Distinct(StringComparer.Ordinal)
            .Where(r => !known.Contains(r, StringComparer.Ordinal)
                        && !r!.StartsWith("masters are wholly content-derived", StringComparison.Ordinal)
                        && !r.StartsWith("widened scalar column", StringComparison.Ordinal)
                        && !r.StartsWith("nested struct with no usable write door", StringComparison.Ordinal)
                        && !r.StartsWith("struct column with no resolvable", StringComparison.Ordinal))
            .Order(StringComparer.Ordinal)
            .ToList();

        Assert.True(unknown.Count == 0,
            "A read-only reason appeared that this audit does not know about. Adding one is fine — add " +
            $"it here too, so the vocabulary stays closed:\n  {string.Join("\n  ", unknown)}");
    }

    [Fact]
    public void EveryElementList_HasAConverter()
    {
        var residue = Facts()
            .Where(f => f.ReadOnlyReason == SchemaRefusals.UnconvertibleElementListReason)
            .Select(f => f.Path)
            .Order(StringComparer.Ordinal)
            .ToList();

        Assert.Empty(residue);
    }

    [Fact]
    public void EveryByteSliceElementList_IsWritable()
    {
        // Pinned by path because the nested one needs a PACK record no edit-path fixture builds, and
        // its writability is still a fact worth holding.
        var byteSliceLists = new[] { "dlvw.TNAMs", "mato.DNAMs", "pack.ProcedureTree.Unknown" };

        var declaredReadOnly = Facts()
            .Where(f => byteSliceLists.Contains(f.Path, StringComparer.Ordinal) && f.ReadOnlyReason != null)
            .Select(f => $"{f.Path}: {f.ReadOnlyReason}")
            .ToList();

        Assert.Empty(declaredReadOnly);
        Assert.Equal(byteSliceLists.Length, Facts().Count(f => byteSliceLists.Contains(f.Path, StringComparer.Ordinal)));
    }

    [Fact]
    public void HeaderColumns_AreDeclaredReadOnlyWithReasons()
    {
        var header = Facts().Where(f => f.Path.StartsWith("header.", StringComparison.Ordinal)).ToList();

        Assert.Equal(3, header.Count);
        Assert.All(header, f => Assert.False(string.IsNullOrWhiteSpace(f.ReadOnlyReason)));
    }
}
