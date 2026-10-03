using MEditService.Codec.Schema;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Codec.Tests.Schema;

public class LeafTypeNameSchemaTests
{
    private static readonly IReadOnlyDictionary<string, RecordTableSchema> Schemas =
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);

    private static FieldMetadata Column(string table, string column) =>
        Schemas[table].RecordColumns.Single(c => c.Name == column).ToFieldMetadata();

    private static FieldMetadata Member(FieldMetadata meta, string name) =>
        (meta.Fields ?? throw new InvalidOperationException($"Expected fields to look up member '{name}'."))
            .Single(f => f.Name == name);

    private static FieldMetadata Element(FieldMetadata meta) =>
        meta.ElementType ?? throw new InvalidOperationException("Expected an element type.");

    [Fact]
    public void StructColumn_NamesItsLoquiClass() =>
        Assert.Equal(nameof(Destructible), Column("npc_", "Destructible").LeafTypeName);

    [Fact]
    public void StructSubField_NamesItsLoquiClass() =>
        Assert.Equal(
            nameof(ConditionData),
            Member(Element(Column("acti", "Conditions")), "Data").LeafTypeName);

    [Fact]
    public void NonUnionArrayElement_NamesItsLoquiClass() =>
        Assert.Equal(
            nameof(ScriptEntry),
            Element(Member(Column("npc_", "VirtualMachineAdapter"), "Scripts")).LeafTypeName);

    [Fact]
    public void NonUnionArrayElement_NestedUnderAUnionLeaf_NamesItsLoquiClass()
    {
        var scripts = Element(Member(Column("npc_", "VirtualMachineAdapter"), "Scripts"));
        var scriptProperty = Element(Member(scripts, "Properties"));

        Assert.Equal(
            nameof(ScriptObjectProperty),
            Element(Member(scriptProperty, "Objects")).LeafTypeName);
    }

    [Fact]
    public void UnionArrayElement_NamesItsBaseClass_AndKeepsItsDiscriminator_BecauseTheSchemaDeclaredClassAndTheValuesClassAreDifferentFacts()
    {
        var element = Element(Column("acti", "Conditions"));

        Assert.Equal(nameof(Condition), element.LeafTypeName);
        var fields = element.Fields
            ?? throw new InvalidOperationException("Expected the union element to declare fields.");
        Assert.Contains(fields, f => f.IsDiscriminator);
    }

    [Fact]
    public void EveryStructInTheSchema_NamesItsType_BecauseNamingAFewByHandProvesNothingAboutAnElementTheWalkBuildsWithoutAName() =>
        Assert.Empty(PathsWhere(m => m.Type == "struct" && string.IsNullOrEmpty(m.LeafTypeName)));

    [Fact]
    public void NothingButAStruct_NamesAType_SoLeafTypeNameStaysTheAnswerToOneQuestionNotASecondCopyOfType() =>
        Assert.Empty(PathsWhere(m => m.Type != "struct" && m.LeafTypeName != null));

    [Fact]
    public void NoStructIsNamedByItsGetterInterface_BecauseALeafNameIsDrawnFromTheSameVocabularyAsAUnionsDiscriminatorValuesOrTheTwoKeyThePresentationTableDifferently() =>
        Assert.Empty(PathsWhere(m => m.LeafTypeName?.EndsWith("Getter", StringComparison.Ordinal) == true));

    private static List<string> PathsWhere(Func<FieldMetadata, bool> predicate) =>
    [
        .. Schemas
            .SelectMany(s => s.Value.RecordColumns.Select(c => (Path: $"{s.Key}.{c.Name}", Meta: c.ToFieldMetadata())))
            .SelectMany(c => Walk(c.Path, c.Meta))
            .Where(f => predicate(f.Meta))
            .Select(f => f.Path),
    ];

    private static IEnumerable<(string Path, FieldMetadata Meta)> Walk(string path, FieldMetadata meta)
    {
        yield return (path, meta);
        if (meta.ElementType is { } element)
            foreach (var e in Walk(path + "[]", element)) yield return e;
        foreach (var field in meta.Fields ?? [])
            foreach (var f in Walk($"{path}.{field.Name}", field)) yield return f;
    }
}
