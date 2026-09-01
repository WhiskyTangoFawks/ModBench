using System.Reflection;
using MEditService.Core.Schema;
using Mutagen.Bethesda;

namespace MEditService.Tests.Indexing;

/// <summary>
/// #649 AC #2 / commitment 3: read/write symmetry is <b>structural</b>. Every leaf emits its Extract
/// and its Apply as a pair, or is declared read-only with a named reason.
///
/// <para><b>What the type already guarantees, and what this file adds.</b> Since
/// <see cref="LeafWrite{TTarget}"/> landed, "Apply is accidentally null" is not a state that can be
/// spelled — a leaf cannot be constructed without choosing, and choosing read-only costs a sentence.
/// So the interesting assertion is no longer "did anyone forget an Apply"; it is the inverse, and it
/// is the one a type cannot make:</para>
///
/// <para><b>A leaf whose shape is writable must not be <i>declared</i> read-only.</b> That is what
/// catches a real regression. Reverting #643's nested-struct write path, for instance, no longer even
/// compiles as a bare <c>Apply: null</c> — whoever reverts it must now write a read-only reason for
/// 83 writable pairs — and this is what refuses to let them: those pairs have resolvable, non-abstract
/// Loqui setter classes, so declaring them read-only is a lie the audit catches.</para>
///
/// <para>Writability is re-derived here from Mutagen directly (does this getter type resolve to a
/// concrete, instantiable Loqui setter class?), never from <c>SchemaReflector</c>'s own decision —
/// the same independence posture <c>SchemaReflectorLeafCoverageCompletenessTests</c> takes. Calling
/// into the classification would make this a tautology.</para>
/// </summary>
public class SchemaReflectorWriteSymmetryTests
{
    private static IReadOnlyList<SchemaReflector.LeafWriteFact> Facts() =>
        SharedSchemaReflector.Instance.EnumerateWriteCapability(GameRelease.Fallout4);

    /// <summary>
    /// Mirrors <c>SchemaReflector.GetSetterType</c>: a Loqui getter interface's registration names the
    /// concrete class that backs it. A non-null, non-abstract one means "there is something a write
    /// could construct and set" — the definition of writable-shaped, derived from Mutagen rather than
    /// from the reflector.
    /// </summary>
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
            "reverted nested-struct write path looks like (#643).\n  " + string.Join("\n  ", lies));
    }

    /// <summary>
    /// Every read-only reason in the schema comes from the small, named vocabulary
    /// <c>SchemaReflector</c> declares. A mass re-declaration cannot slip through by inventing prose:
    /// it either reuses a reason that <see cref="NoWritableShapedNestedStruct_IsDeclaredReadOnly"/>
    /// then rejects on shape, or it invents one and fails here.
    /// </summary>
    [Fact]
    public void EveryReadOnlyReason_ComesFromTheDeclaredVocabulary()
    {
        var known = new[]
        {
            SchemaReflector.DiscriminatorReason,
            SchemaReflector.ElementTemplateReason,
            SchemaReflector.PrimitiveElementListReason,
            SchemaReflector.NoConverterReason,
            SchemaReflector.HeaderNoWritePathReason,
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

    /// <summary>
    /// The plugin header's three columns (#661 made them reachable) are declared read-only with real
    /// reasons rather than being anomalies — the live population commitment 3 was written for. Pinned
    /// because it is the one place a reader might expect a gap and find a decision instead.
    /// </summary>
    [Fact]
    public void HeaderColumns_AreDeclaredReadOnlyWithReasons()
    {
        var header = Facts().Where(f => f.Path.StartsWith("header.", StringComparison.Ordinal)).ToList();

        Assert.Equal(3, header.Count);
        Assert.All(header, f => Assert.False(string.IsNullOrWhiteSpace(f.ReadOnlyReason)));
    }
}
