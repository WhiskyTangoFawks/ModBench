using MEditService.Core.Queries;
using MEditService.Core.Schema;
using Mutagen.Bethesda;

namespace MEditService.Tests.Schema;

/// <summary>A leaf kind is built once, so its facts do not depend on where the walk reached it: a
/// top-level column, a member nested inside a struct and an array element all read alike (ADR-0032).</summary>
public sealed class OneLeafBuilderTests
{
    private static readonly IReadOnlyDictionary<string, RecordTableSchema> Schemas =
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);

    private static IEnumerable<(string Path, int Depth, FieldMetadata Meta)> Walk(string path, int depth, FieldMetadata meta)
    {
        yield return (path, depth, meta);
        foreach (var child in Children(meta))
        {
            foreach (var deep in Walk($"{path}.{child.Name}", depth + 1, child)) yield return deep;
        }
    }

    private static IEnumerable<FieldMetadata> Children(FieldMetadata meta) =>
        (meta.Fields ?? [])
        .Concat(meta.ElementType is { } element ? [element] : [])
        .Concat(meta.Variants?.Values ?? []);

    private static List<(string Path, int Depth, FieldMetadata Meta)> FormLinkArrays() =>
    [
        .. Schemas
            .SelectMany(s => s.Value.RecordColumns.SelectMany(c => Walk($"{s.Key}.{c.Name}", 0, c.ToFieldMetadata())))
            .Where(x => x.Meta is { Type: "array", ElementType.Type: "formKey" }),
    ];

    // The array-of-form-links kind, which ConflictClassifier sorts and treats as sparse, is reached
    // both as a record's own column and several hops down inside a struct.
    [Fact]
    public void AFormLinkArray_IsReachedBothAsAColumnAndNestedInsideAStruct()
    {
        var arrays = FormLinkArrays();

        Assert.Contains(arrays, x => x.Depth == 0);
        Assert.Contains(arrays, x => x.Depth > 0);
    }

    private static string ArraysWhoseElement(Func<FieldMetadata, bool> lacks) =>
        string.Join("\n", FormLinkArrays()
            .Where(x => lacks(x.Meta.ElementType!))
            .Select(x => x.Path)
            .Distinct(StringComparer.Ordinal));

    [Fact]
    public void EveryFormLinkArrayElement_IsSortable_HoweverDeepTheWalkReachedIt()
    {
        var unsorted = ArraysWhoseElement(e => !e.IsSortable);

        Assert.True(unsorted.Length == 0, unsorted);
    }

    // Absence is a value or it is a default, and only the getter's own annotation says which: the
    // CLR type is a reference type either way for a struct, and carries no default for a string.
    [Theory]
    [InlineData("cont", "Destructible", true)]
    [InlineData("cont", "ObjectBounds", false)]
    [InlineData("npc_", "Name", true)]
    [InlineData("npc_", "HeightMin", false)]
    public void AMember_SaysWhetherAbsenceIsAValue(string table, string column, bool allowsNull)
    {
        Assert.Equal(allowsNull, Schemas[table].RecordColumns.Single(c => c.Name == column).Field.AllowsNull);
    }

    // A "Null" slot is a tolerated placeholder in any form-link array, not a dangling reference.
    [Fact]
    public void EveryFormLinkArrayElement_AllowsNull_HoweverDeepTheWalkReachedIt()
    {
        var strict = ArraysWhoseElement(e => !e.AllowsNull);

        Assert.True(strict.Length == 0, strict);
    }
}
