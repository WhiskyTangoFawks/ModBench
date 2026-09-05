using MEditService.Core.Queries;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Tests.Indexing;

/// <summary>Every struct names the Loqui/CLR class it is, out of the same vocabulary a union's
/// discriminator values come from.</summary>
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
        Assert.Equal(nameof(Destructible), Column("npc_", "Destructible").LeafTypeName);

    [Fact]
    public void StructSubField_NamesItsLoquiClass() =>
        Assert.Equal(
            nameof(ConditionData),
            Member(Column("acti", "Conditions").ElementType!, "Data").LeafTypeName);

    [Fact]
    public void NonUnionArrayElement_NamesItsLoquiClass() =>
        Assert.Equal(
            nameof(ScriptEntry),
            Member(Column("npc_", "VirtualMachineAdapter"), "Scripts").ElementType!.LeafTypeName);

    [Fact]
    public void NonUnionArrayElement_NestedUnderAUnionLeaf_NamesItsLoquiClass()
    {
        var scriptProperty = Member(Column("npc_", "VirtualMachineAdapter"), "Scripts")
            .ElementType!.Fields!.Single(f => f.Name == "Properties").ElementType!;

        Assert.Equal(
            nameof(ScriptObjectProperty),
            Member(scriptProperty, "Objects").ElementType!.LeafTypeName);
    }

    // A union element names its own base class and still carries its discriminator: the two are
    // different facts about the same object (which class the schema declares, which class the
    // value is), so neither displaces the other.
    [Fact]
    public void UnionArrayElement_NamesItsBaseClass_AndKeepsItsDiscriminator()
    {
        var element = Column("acti", "Conditions").ElementType!;

        Assert.Equal(nameof(Condition), element.LeafTypeName);
        Assert.Contains(element.Fields!, f => f.IsDiscriminator);
    }

    // The completeness half: naming three structs by hand proves nothing about the rest of the
    // schema, and an element the walk builds without a name is exactly the gap this closes.
    [Fact]
    public void EveryStructInTheSchema_NamesItsType() =>
        Assert.Empty(PathsWhere(m => m.Type == "struct" && string.IsNullOrEmpty(m.LeafTypeName)));

    // The other half of the same rule: a scalar is not a struct and names no type, so the field
    // stays the answer to one question rather than a second copy of `Type`.
    [Fact]
    public void NothingButAStruct_NamesAType() =>
        Assert.Empty(PathsWhere(m => m.Type != "struct" && m.LeafTypeName != null));

    // What is named is the class, never the getter interface the walk reached it through: a leaf's
    // name must be drawn from the same vocabulary a union's discriminator values are, or the two key
    // the presentation table differently.
    [Fact]
    public void NoStructIsNamedByItsGetterInterface() =>
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
