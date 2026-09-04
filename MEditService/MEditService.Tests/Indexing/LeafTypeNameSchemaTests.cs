using MEditService.Core.Queries;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Tests.Indexing;

/// <summary>
/// #717: every struct the schema describes names the Loqui/CLR class it is, so a consumer can key
/// on that name whether or not the struct happens to be an abstract union with a discriminator.
/// A union leaf and a plain struct name themselves out of the same vocabulary — an element of
/// <c>ScriptObjectListProperty.Objects</c> reads <c>ScriptObjectProperty</c>, which is also the
/// discriminator value the same class has as a leaf of <c>ScriptProperty</c>'s own union.
/// </summary>
public class LeafTypeNameSchemaTests
{
    private static readonly IReadOnlyDictionary<string, Core.Schema.RecordTableSchema> Schemas =
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);

    private static FieldMetadata Column(string table, string column) =>
        Schemas[table].RecordColumns.Single(c => c.Name == column).ToFieldMetadata();

    private static FieldMetadata Member(FieldMetadata meta, string name) =>
        meta.Fields!.Single(f => f.Name == name);

    [Fact]
    public void StructColumn_NamesItsLoquiClass() =>
        Assert.Equal(nameof(Destructible), Column("npc_", "destructible").LeafTypeName);

    [Fact]
    public void StructSubField_NamesItsLoquiClass() =>
        Assert.Equal(
            nameof(ConditionData),
            Member(Column("acti", "conditions").ElementType!, "data").LeafTypeName);

    [Fact]
    public void NonUnionArrayElement_NamesItsLoquiClass() =>
        Assert.Equal(
            nameof(ScriptEntry),
            Member(Column("npc_", "virtual_machine_adapter"), "scripts").ElementType!.LeafTypeName);

    [Fact]
    public void NonUnionArrayElement_NestedUnderAUnionLeaf_NamesItsLoquiClass()
    {
        var scriptProperty = Member(Column("npc_", "virtual_machine_adapter"), "scripts")
            .ElementType!.Fields!.Single(f => f.Name == "properties").ElementType!;

        Assert.Equal(
            nameof(ScriptObjectProperty),
            Member(scriptProperty, "objects").ElementType!.LeafTypeName);
    }

    // A union element names its own base class and still carries its discriminator: the two are
    // different facts about the same object (which class the schema declares, which class the
    // value is), so neither displaces the other.
    [Fact]
    public void UnionArrayElement_NamesItsBaseClass_AndKeepsItsDiscriminator()
    {
        var element = Column("acti", "conditions").ElementType!;

        Assert.Equal(nameof(Condition), element.LeafTypeName);
        Assert.Contains(element.Fields!, f => f.IsDiscriminator);
    }

    // The completeness half: naming three structs by hand proves nothing about the rest of the
    // schema, and an element the walk builds without a name is exactly the gap #717 closes.
    [Fact]
    public void EveryStructInTheSchema_NamesItsType()
    {
        var unnamed = Schemas
            .SelectMany(s => s.Value.RecordColumns.Select(c => (Path: $"{s.Key}.{c.Name}", Meta: c.ToFieldMetadata())))
            .SelectMany(c => Walk(c.Path, c.Meta))
            .Where(f => f.Meta.Type == "struct" && string.IsNullOrEmpty(f.Meta.LeafTypeName))
            .Select(f => f.Path)
            .ToList();

        Assert.Empty(unnamed);
    }

    // The other half of the same rule: a scalar is not a struct and names no type, so the field
    // stays the answer to one question rather than a second copy of `Type`.
    [Fact]
    public void NothingButAStruct_NamesAType()
    {
        var named = Schemas
            .SelectMany(s => s.Value.RecordColumns.Select(c => (Path: $"{s.Key}.{c.Name}", Meta: c.ToFieldMetadata())))
            .SelectMany(c => Walk(c.Path, c.Meta))
            .Where(f => f.Meta.Type != "struct" && f.Meta.LeafTypeName != null)
            .Select(f => f.Path)
            .ToList();

        Assert.Empty(named);
    }

    private static IEnumerable<(string Path, FieldMetadata Meta)> Walk(string path, FieldMetadata meta)
    {
        yield return (path, meta);
        if (meta.ElementType is { } element)
            foreach (var e in Walk(path + "[]", element)) yield return e;
        foreach (var field in meta.Fields ?? [])
            foreach (var f in Walk($"{path}.{field.Name}", field)) yield return f;
    }
}
