using System.Text.Json;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;

namespace MEditService.Tests.Records;

public class FormRefPathBuilderTests
{
    private static ColumnSpec ScalarFormKeyCol(string name) =>
        new(name, name, "VARCHAR", _ => null, "formKey", [], [], null);

    private static ColumnSpec ArrayFormKeyCol(string name) =>
        new(name, name, "JSON", _ => null, "array", [], [], null,
            IsArray: true,
            ElementType: new FieldMetadata(name, "formKey", false, [], []));

    private static ColumnSpec ArrayStructCol(string name, params string[] fkSubFields)
    {
        var fields = fkSubFields
            .Select(f => new FieldMetadata(f, "formKey", false, [], []))
            .ToList<FieldMetadata>();
        return new(name, name, "JSON", _ => null, "array", [], [], null,
            IsArray: true,
            ElementType: new FieldMetadata(name, "struct", false, [], [], Fields: fields));
    }

    private static List<(string Path, string Fk)> Collect(ColumnSpec col, object? value)
    {
        var results = new List<(string, string)>();
        FormRefPathBuilder.Walk(col, _ => value, (path, fk) => results.Add((path, fk)));
        return results;
    }

    // --- Case 1: scalar formKey ---

    [Fact]
    public void Walk_ScalarFormKey_StringInput_CallsVisitor()
    {
        var col = ScalarFormKeyCol("race");
        var hits = Collect(col, "000001:Fallout4.esm");
        Assert.Single(hits);
        Assert.Equal(("race", "000001:Fallout4.esm"), hits[0]);
    }

    [Fact]
    public void Walk_ScalarFormKey_JsonElementInput_CallsVisitor()
    {
        var col = ScalarFormKeyCol("race");
        var je = JsonDocument.Parse("\"000002:Plugin.esp\"").RootElement.Clone();
        var hits = Collect(col, je);
        Assert.Single(hits);
        Assert.Equal(("race", "000002:Plugin.esp"), hits[0]);
    }

    [Fact]
    public void Walk_ScalarFormKey_NullString_DoesNotCallVisitor()
    {
        var col = ScalarFormKeyCol("race");
        Assert.Empty(Collect(col, (string?)null));
    }

    [Fact]
    public void Walk_ScalarFormKey_NullLiteralString_DoesNotCallVisitor()
    {
        var col = ScalarFormKeyCol("race");
        Assert.Empty(Collect(col, "Null"));
    }

    // --- Case 2: array of formKey ---

    [Fact]
    public void Walk_ArrayFormKey_StringJsonInput_IndexedPaths()
    {
        var col = ArrayFormKeyCol("keywords");
        var json = "[\"000001:Fallout4.esm\",\"000002:Plugin.esp\"]";
        var hits = Collect(col, json);
        Assert.Equal(2, hits.Count);
        Assert.Equal(("keywords[0]", "000001:Fallout4.esm"), hits[0]);
        Assert.Equal(("keywords[1]", "000002:Plugin.esp"), hits[1]);
    }

    [Fact]
    public void Walk_ArrayFormKey_JsonElementInput_IndexedPaths()
    {
        var col = ArrayFormKeyCol("keywords");
        var je = JsonDocument.Parse("[\"000001:Fallout4.esm\",\"000002:Plugin.esp\"]").RootElement.Clone();
        var hits = Collect(col, je);
        Assert.Equal(2, hits.Count);
        Assert.Equal(("keywords[0]", "000001:Fallout4.esm"), hits[0]);
        Assert.Equal(("keywords[1]", "000002:Plugin.esp"), hits[1]);
    }

    [Fact]
    public void Walk_ArrayFormKey_NullAndNullLiteralEntriesSkipped()
    {
        var col = ArrayFormKeyCol("keywords");
        var json = "[null,\"Null\",\"000003:Plugin.esp\"]";
        var hits = Collect(col, json);
        Assert.Single(hits);
        Assert.Equal(("keywords[2]", "000003:Plugin.esp"), hits[0]);
    }

    // --- Case 3: array of struct with formKey subfields ---

    [Fact]
    public void Walk_ArrayStruct_StringJsonInput_SubFieldPaths()
    {
        var col = ArrayStructCol("factions", "faction");
        var json = "[{\"faction\":\"000010:Plugin.esp\",\"rank\":1}]";
        var hits = Collect(col, json);
        Assert.Single(hits);
        Assert.Equal(("factions[0].faction", "000010:Plugin.esp"), hits[0]);
    }

    [Fact]
    public void Walk_ArrayStruct_JsonElementInput_SubFieldPaths()
    {
        var col = ArrayStructCol("factions", "faction");
        var je = JsonDocument.Parse("[{\"faction\":\"000010:Plugin.esp\",\"rank\":1}]").RootElement.Clone();
        var hits = Collect(col, je);
        Assert.Single(hits);
        Assert.Equal(("factions[0].faction", "000010:Plugin.esp"), hits[0]);
    }

    [Fact]
    public void Walk_ArrayStruct_NonFormKeySubFieldsIgnored()
    {
        var col = ArrayStructCol("factions", "faction"); // "rank" is not in fkSubFields
        var json = "[{\"faction\":\"000010:Plugin.esp\",\"rank\":1}]";
        var hits = Collect(col, json);
        Assert.Single(hits);
    }

    [Fact]
    public void Walk_ArrayStruct_NullLiteralSubFieldSkipped()
    {
        var col = ArrayStructCol("factions", "faction");
        var json = "[{\"faction\":\"Null\"}]";
        Assert.Empty(Collect(col, json));
    }

    [Fact]
    public void Walk_ArrayStruct_MultipleElementsMultipleSubFields_AllPaths()
    {
        var col = ArrayStructCol("links", "linkFrom", "linkTo");
        var json = "[{\"linkFrom\":\"000001:A.esp\",\"linkTo\":\"000002:A.esp\"},{\"linkFrom\":\"000003:A.esp\",\"linkTo\":\"000004:A.esp\"}]";
        var hits = Collect(col, json);
        Assert.Equal(4, hits.Count);
        Assert.Contains(("links[0].linkFrom", "000001:A.esp"), hits);
        Assert.Contains(("links[0].linkTo", "000002:A.esp"), hits);
        Assert.Contains(("links[1].linkFrom", "000003:A.esp"), hits);
        Assert.Contains(("links[1].linkTo", "000004:A.esp"), hits);
    }

    // --- Unrecognized ApiType ---

    [Fact]
    public void Walk_UnknownApiType_DoesNotCallVisitor()
    {
        var col = new ColumnSpec("name", "Name", "VARCHAR", _ => null, "string", [], [], null);
        Assert.Empty(Collect(col, "some value"));
    }

    // --- Non-string/non-null elements in formKey array skipped (not throw) ---

    [Fact]
    public void Walk_ArrayFormKey_NonStringElementSkipped()
    {
        var col = ArrayFormKeyCol("keywords");
        var json = "[1, \"000001:Fallout4.esm\", true]";
        var hits = Collect(col, json);
        Assert.Single(hits);
        Assert.Equal(("keywords[1]", "000001:Fallout4.esm"), hits[0]);
    }

    // --- Non-object elements in struct array skipped (not throw) ---

    [Fact]
    public void Walk_ArrayStruct_NullElementSkipped()
    {
        var col = ArrayStructCol("factions", "faction");
        var json = "[null, {\"faction\":\"000010:Plugin.esp\"}]";
        var hits = Collect(col, json);
        Assert.Single(hits);
        Assert.Equal(("factions[1].faction", "000010:Plugin.esp"), hits[0]);
    }

    [Fact]
    public void Walk_ArrayStruct_NonObjectElementSkipped()
    {
        var col = ArrayStructCol("factions", "faction");
        var json = "[\"not-an-object\", {\"faction\":\"000010:Plugin.esp\"}]";
        var hits = Collect(col, json);
        Assert.Single(hits);
        Assert.Equal(("factions[1].faction", "000010:Plugin.esp"), hits[0]);
    }

    [Fact]
    public void Walk_ArrayStruct_MissingSubFieldSkipped()
    {
        var col = ArrayStructCol("factions", "faction");
        var json = "[{\"rank\":1}]";
        Assert.Empty(Collect(col, json));
    }

    // --- Array with null ElementType (SchemaReflector can produce this for opaque Loqui elements) ---

    [Fact]
    public void Walk_ArrayWithNullElementType_DoesNotCallVisitor()
    {
        var col = new ColumnSpec("items", "items", "JSON", _ => null, "array", [], [], null,
            IsArray: true, ElementType: null);
        var hits = Collect(col, "[\"000001:Fallout4.esm\"]");
        Assert.Empty(hits);
    }

    // --- Depth-2: struct sub-field that is itself a struct containing a formKey ---

    [Fact]
    public void Walk_ArrayStruct_NestedStructSubField_FormKeyReached()
    {
        var innerFk = new FieldMetadata("target", "formKey", false, [], []);
        var innerStruct = new FieldMetadata("inner", "struct", false, [], [], Fields: [innerFk]);
        var elemMeta = new FieldMetadata("", "struct", false, [], [], Fields: [innerStruct]);
        var col = new ColumnSpec("links", "links", "JSON", _ => null, "array", [], [], null,
            IsArray: true, ElementType: elemMeta);

        var json = "[{\"inner\":{\"target\":\"000001:Plugin.esp\"}}]";
        var hits = Collect(col, json);

        Assert.Single(hits);
        Assert.Equal(("links[0].inner.target", "000001:Plugin.esp"), hits[0]);
    }
}
