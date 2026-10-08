using MEditService.Codec.Schema;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Codec.Tests.Schema;

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
            .SelectMany(s => s.Value.RecordColumns.SelectMany(c => Walk($"{s.Key}.{c.Name}", 0, c.Field)))
            .Where(x => x.Meta is { Type: "array", ElementType.Type: "formKey" }),
    ];

    [Fact]
    public void AFormLinkArray_IsReachedBothAsAColumnAndNestedInsideAStruct_ChosenBecauseConflictClassifierSortsAndTreatsThisKindAsSparse()
    {
        var arrays = FormLinkArrays();

        Assert.Contains(arrays, x => x.Depth == 0);
        Assert.Contains(arrays, x => x.Depth > 0);
    }

    private static string ArraysWhoseElement(Func<FieldMetadata, bool> lacks) =>
        string.Join("\n", FormLinkArrays()
            .Where(x => lacks(x.Meta.ElementType ?? throw new InvalidOperationException($"Expected '{x.Path}' to have an element type.")))
            .Select(x => x.Path)
            .Distinct(StringComparer.Ordinal));

    [Theory]
    [InlineData("cont", "Destructible", true)]
    [InlineData("cont", "ObjectBounds", false)]
    [InlineData("npc_", "Name", true)]
    [InlineData("npc_", "HeightMin", false)]
    public void AMember_SaysWhetherAbsenceIsAValue_BecauseOnlyTheGettersOwnAnnotationSaysSinceTheClrTypeIsAReferenceTypeEitherWayForAStructAndCarriesNoDefaultForAString(string table, string column, bool allowsNull)
    {
        Assert.Equal(allowsNull, Schemas[table].RecordColumns.Single(c => c.Name == column).Field.AllowsNull);
    }

    [Fact]
    public void EveryFormLinkArrayElement_AllowsNull_HoweverDeepTheWalkReachedIt_BecauseANullSlotIsAToleratedPlaceholderNotADanglingReference()
    {
        var strict = ArraysWhoseElement(e => !e.AllowsNull);

        Assert.True(strict.Length == 0, strict);
    }
}
