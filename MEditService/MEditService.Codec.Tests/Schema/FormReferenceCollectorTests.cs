using System.Text.Json;
using MEditService.Codec.Schema;

namespace MEditService.Codec.Tests.Schema;

public class FormReferenceCollectorTests
{
    private static ColumnSpec Column(FieldMetadata field) => new(field, field.Name);

    private static ColumnSpec ScalarFormKeyCol(string name) =>
        new(new FieldMetadata(name, "formKey", false, [], []), name);

    private static ColumnSpec ArrayFormKeyCol(string name) =>
        Column(new FieldMetadata(name, "array", true, [], [], ElementType: new FieldMetadata(name, "formKey", false, [], [])));

    private static ColumnSpec ArrayStructCol(string name, params string[] fkSubFields) =>
        Column(new FieldMetadata(name, "array", true, [], [],
            ElementType: new FieldMetadata(name, "struct", false, [], [],
                Fields: [.. fkSubFields.Select(f => new FieldMetadata(f, "formKey", false, [], []))])));

    private static List<(string Path, string Fk)> Collect(ColumnSpec col, string? value)
    {
        var results = new List<(string, string)>();
        var member = value switch
        {
            null => "null",
            _ when value.StartsWith('[') || value.StartsWith('{') => value,
            _ => JsonSerializer.Serialize(value),
        };
        using var root = JsonDocument.Parse($"{{\"{col.PropertyName}\": {member}}}");
        results.AddRange(FormReferences.Collect(root.RootElement, [col]).Select(r => (r.FieldPath, r.TargetFormKey)));
        return results;
    }

    [Fact]
    public void Collect_ScalarFormKey_StringInput_IsYielded()
    {
        var col = ScalarFormKeyCol("Race");
        var hits = Collect(col, "000001:Fallout4.esm");
        Assert.Single(hits);
        Assert.Equal(("Race", "000001:Fallout4.esm"), hits[0]);
    }

    [Fact]
    public void Collect_ScalarFormKey_NullString_IsNotYielded()
    {
        var col = ScalarFormKeyCol("Race");
        Assert.Empty(Collect(col, (string?)null));
    }

    [Fact]
    public void Collect_ScalarFormKey_NullLiteralString_IsNotYielded()
    {
        var col = ScalarFormKeyCol("Race");
        Assert.Empty(Collect(col, "Null"));
    }

    [Fact]
    public void Collect_ArrayFormKey_StringJsonInput_IndexedPaths()
    {
        var col = ArrayFormKeyCol("Keywords");
        var json = "[\"000001:Fallout4.esm\",\"000002:Plugin.esp\"]";
        var hits = Collect(col, json);
        Assert.Equal(2, hits.Count);
        Assert.Equal(("Keywords[0]", "000001:Fallout4.esm"), hits[0]);
        Assert.Equal(("Keywords[1]", "000002:Plugin.esp"), hits[1]);
    }

    [Fact]
    public void Collect_ArrayFormKey_NullAndNullLiteralEntriesSkipped()
    {
        var col = ArrayFormKeyCol("Keywords");
        var json = "[null,\"Null\",\"000003:Plugin.esp\"]";
        var hits = Collect(col, json);
        Assert.Single(hits);
        Assert.Equal(("Keywords[2]", "000003:Plugin.esp"), hits[0]);
    }

    [Fact]
    public void Collect_ArrayStruct_StringJsonInput_SubFieldPaths()
    {
        var col = ArrayStructCol("Factions", "Faction");
        var json = "[{\"Faction\":\"000010:Plugin.esp\",\"Rank\":1}]";
        var hits = Collect(col, json);
        Assert.Single(hits);
        Assert.Equal(("Factions[0].Faction", "000010:Plugin.esp"), hits[0]);
    }

    [Fact]
    public void Collect_ArrayStruct_NullLiteralSubFieldSkipped()
    {
        var col = ArrayStructCol("Factions", "Faction");
        var json = "[{\"Faction\":\"Null\"}]";
        Assert.Empty(Collect(col, json));
    }

    [Fact]
    public void Collect_ArrayStruct_MultipleElementsMultipleSubFields_AllPaths()
    {
        var col = ArrayStructCol("links", "LinkFrom", "LinkTo");
        var json = "[{\"LinkFrom\":\"000001:A.esp\",\"LinkTo\":\"000002:A.esp\"},{\"LinkFrom\":\"000003:A.esp\",\"LinkTo\":\"000004:A.esp\"}]";
        var hits = Collect(col, json);
        Assert.Equal(4, hits.Count);
        Assert.Contains(("links[0].LinkFrom", "000001:A.esp"), hits);
        Assert.Contains(("links[0].LinkTo", "000002:A.esp"), hits);
        Assert.Contains(("links[1].LinkFrom", "000003:A.esp"), hits);
        Assert.Contains(("links[1].LinkTo", "000004:A.esp"), hits);
    }

    [Fact]
    public void Collect_UnknownApiType_IsNotYielded()
    {
        var col = new ColumnSpec(new FieldMetadata("Name", "string", false, [], []), "Name");
        Assert.Empty(Collect(col, "some value"));
    }

    [Fact]
    public void Collect_ArrayFormKey_NonStringElementSkipped()
    {
        var col = ArrayFormKeyCol("Keywords");
        var json = "[1, \"000001:Fallout4.esm\", true]";
        var hits = Collect(col, json);
        Assert.Single(hits);
        Assert.Equal(("Keywords[1]", "000001:Fallout4.esm"), hits[0]);
    }

    [Fact]
    public void Collect_ArrayStruct_NullElementSkipped()
    {
        var col = ArrayStructCol("Factions", "Faction");
        var json = "[null, {\"Faction\":\"000010:Plugin.esp\"}]";
        var hits = Collect(col, json);
        Assert.Single(hits);
        Assert.Equal(("Factions[1].Faction", "000010:Plugin.esp"), hits[0]);
    }

    [Fact]
    public void Collect_ArrayStruct_NonObjectElementSkipped()
    {
        var col = ArrayStructCol("Factions", "Faction");
        var json = "[\"not-an-object\", {\"Faction\":\"000010:Plugin.esp\"}]";
        var hits = Collect(col, json);
        Assert.Single(hits);
        Assert.Equal(("Factions[1].Faction", "000010:Plugin.esp"), hits[0]);
    }

    [Fact]
    public void Collect_ArrayStruct_MissingSubFieldSkipped()
    {
        var col = ArrayStructCol("Factions", "Faction");
        var json = "[{\"Rank\":1}]";
        Assert.Empty(Collect(col, json));
    }

    [Fact]
    public void Collect_ArrayWithNullElementType_IsNotYielded_BecauseSchemaReflectorProducesOneForOpaqueLoquiElements()
    {
        var col = Column(new FieldMetadata("items", "array", true, [], [], ElementType: null));
        var hits = Collect(col, "[\"000001:Fallout4.esm\"]");
        Assert.Empty(hits);
    }

    [Fact]
    public void Collect_ArrayStruct_NestedStructSubField_FormKeyReached()
    {
        var innerFk = new FieldMetadata("Target", "formKey", false, [], []);
        var innerStruct = new FieldMetadata("inner", "struct", false, [], [], Fields: [innerFk]);
        var elemSpec = new FieldMetadata("", "struct", false, [], [], Fields: [innerStruct]);
        var col = Column(new FieldMetadata("links", "array", true, [], [], ElementType: elemSpec));

        var json = "[{\"inner\":{\"Target\":\"000001:Plugin.esp\"}}]";
        var hits = Collect(col, json);

        Assert.Single(hits);
        Assert.Equal(("links[0].inner.Target", "000001:Plugin.esp"), hits[0]);
    }

    [Fact]
    public void Collect_ARecordWithANestedStruct_AListOfLinks_AndAUnionField_YieldsEachTargetOnce_TheLeafNamedByTheDocumentsOwnDiscriminatorDecidingTheShape()
    {
        var nested = Column(new FieldMetadata("Ownership", "struct", false, [], [],
            Fields: [new FieldMetadata("Owner", "struct", false, [], [],
                Fields: [new FieldMetadata("Faction", "formKey", false, [], [])])]));
        var list = Column(new FieldMetadata("Keywords", "array", true, [], [],
            ElementType: new FieldMetadata("Keywords", "formKey", false, [], [])));
        var union = Column(new FieldMetadata("Value", "struct", false, [], [], Variants: new Dictionary<string, FieldMetadata>
        {
            ["ObjectValue"] = new FieldMetadata("Value", "struct", false, [], [],
                Fields: [new FieldMetadata("Object", "formKey", false, [], [])]),
            ["StringValue"] = new FieldMetadata("Value", "struct", false, [], [],
                Fields: [new FieldMetadata("Text", "string", false, [], [])]),
        }));

        using var document = JsonDocument.Parse($$"""
            {
              "{{LoquiUnions.UnionTypeDiscriminator}}": "ObjectValue",
              "Ownership": { "Owner": { "Faction": "000001:A.esp" } },
              "Keywords": ["000002:A.esp", "000003:A.esp"],
              "Value": { "Object": "000004:A.esp" }
            }
            """);

        var refs = FormReferences.Collect(document.RootElement, [nested, list, union]);

        Assert.Equal(
            [("Ownership.Owner.Faction", "000001:A.esp"),
             ("Keywords[0]", "000002:A.esp"),
             ("Keywords[1]", "000003:A.esp"),
             ("Value.Object", "000004:A.esp")],
            refs.Select(r => (r.FieldPath, r.TargetFormKey)));
    }
}
