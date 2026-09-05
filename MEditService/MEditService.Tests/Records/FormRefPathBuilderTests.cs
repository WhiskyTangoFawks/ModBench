using System.Text.Json;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Records;

public class FormRefPathBuilderTests
{
    private static ColumnSpec ScalarFormKeyCol(string name) =>
        new(name, name, "VARCHAR", "formKey", [], [], LeafWrite.ReadOnly<IMajorRecord>("test fixture: write capability is not under test"));

    private static ColumnSpec ArrayFormKeyCol(string name) =>
        new(name, name, "JSON", "array", [], [], LeafWrite.ReadOnly<IMajorRecord>("test fixture: write capability is not under test"),
            IsArray: true,
            ElementType: new FieldMetadata(name, "formKey", false, [], []));

    private static ColumnSpec ArrayStructCol(string name, params string[] fkSubFields)
    {
        var fields = fkSubFields
            .Select(f => new FieldMetadata(f, "formKey", false, [], []))
            .ToList<FieldMetadata>();
        return new(name, name, "JSON", "array", [], [], LeafWrite.ReadOnly<IMajorRecord>("test fixture: write capability is not under test"),
            IsArray: true,
            ElementType: new FieldMetadata(name, "struct", false, [], [], Fields: fields));
    }

    // The column's value sits in a document under the column's own name; JSON text is the
    // document's spelling of it, a JsonElement one already parsed.
    private static List<(string Path, string Fk)> Collect(ColumnSpec col, object? value)
    {
        var results = new List<(string, string)>();
        var member = value switch
        {
            null => "null",
            JsonElement je => je.GetRawText(),
            string text when text.StartsWith('[') || text.StartsWith('{') => text,
            string text => JsonSerializer.Serialize(text),
            _ => JsonSerializer.Serialize(value),
        };
        using var root = JsonDocument.Parse($"{{\"{col.PropertyName}\": {member}}}");
        FormRefPathBuilder.Walk(col, root.RootElement, (path, fk) => results.Add((path, fk)));
        return results;
    }

    // --- Case 1: scalar formKey ---

    [Fact]
    public void Walk_ScalarFormKey_StringInput_CallsVisitor()
    {
        var col = ScalarFormKeyCol("Race");
        var hits = Collect(col, "000001:Fallout4.esm");
        Assert.Single(hits);
        Assert.Equal(("Race", "000001:Fallout4.esm"), hits[0]);
    }

    [Fact]
    public void Walk_ScalarFormKey_JsonElementInput_CallsVisitor()
    {
        var col = ScalarFormKeyCol("Race");
        var je = JsonDocument.Parse("\"000002:Plugin.esp\"").RootElement.Clone();
        var hits = Collect(col, je);
        Assert.Single(hits);
        Assert.Equal(("Race", "000002:Plugin.esp"), hits[0]);
    }

    [Fact]
    public void Walk_ScalarFormKey_NullString_DoesNotCallVisitor()
    {
        var col = ScalarFormKeyCol("Race");
        Assert.Empty(Collect(col, (string?)null));
    }

    [Fact]
    public void Walk_ScalarFormKey_NullLiteralString_DoesNotCallVisitor()
    {
        var col = ScalarFormKeyCol("Race");
        Assert.Empty(Collect(col, "Null"));
    }

    // --- Case 2: array of formKey ---

    [Fact]
    public void Walk_ArrayFormKey_StringJsonInput_IndexedPaths()
    {
        var col = ArrayFormKeyCol("Keywords");
        var json = "[\"000001:Fallout4.esm\",\"000002:Plugin.esp\"]";
        var hits = Collect(col, json);
        Assert.Equal(2, hits.Count);
        Assert.Equal(("keywords[0]", "000001:Fallout4.esm"), hits[0]);
        Assert.Equal(("keywords[1]", "000002:Plugin.esp"), hits[1]);
    }

    [Fact]
    public void Walk_ArrayFormKey_JsonElementInput_IndexedPaths()
    {
        var col = ArrayFormKeyCol("Keywords");
        var je = JsonDocument.Parse("[\"000001:Fallout4.esm\",\"000002:Plugin.esp\"]").RootElement.Clone();
        var hits = Collect(col, je);
        Assert.Equal(2, hits.Count);
        Assert.Equal(("keywords[0]", "000001:Fallout4.esm"), hits[0]);
        Assert.Equal(("keywords[1]", "000002:Plugin.esp"), hits[1]);
    }

    [Fact]
    public void Walk_ArrayFormKey_NullAndNullLiteralEntriesSkipped()
    {
        var col = ArrayFormKeyCol("Keywords");
        var json = "[null,\"Null\",\"000003:Plugin.esp\"]";
        var hits = Collect(col, json);
        Assert.Single(hits);
        Assert.Equal(("keywords[2]", "000003:Plugin.esp"), hits[0]);
    }

    // --- Case 3: array of struct with formKey subfields ---

    [Fact]
    public void Walk_ArrayStruct_StringJsonInput_SubFieldPaths()
    {
        var col = ArrayStructCol("Factions", "Faction");
        var json = "[{\"faction\":\"000010:Plugin.esp\",\"rank\":1}]";
        var hits = Collect(col, json);
        Assert.Single(hits);
        Assert.Equal(("factions[0].faction", "000010:Plugin.esp"), hits[0]);
    }

    [Fact]
    public void Walk_ArrayStruct_JsonElementInput_SubFieldPaths()
    {
        var col = ArrayStructCol("Factions", "Faction");
        var je = JsonDocument.Parse("[{\"faction\":\"000010:Plugin.esp\",\"rank\":1}]").RootElement.Clone();
        var hits = Collect(col, je);
        Assert.Single(hits);
        Assert.Equal(("factions[0].faction", "000010:Plugin.esp"), hits[0]);
    }

    [Fact]
    public void Walk_ArrayStruct_NonFormKeySubFieldsIgnored()
    {
        var col = ArrayStructCol("Factions", "Faction"); // "Rank" is not in fkSubFields
        var json = "[{\"faction\":\"000010:Plugin.esp\",\"rank\":1}]";
        var hits = Collect(col, json);
        Assert.Single(hits);
    }

    [Fact]
    public void Walk_ArrayStruct_NullLiteralSubFieldSkipped()
    {
        var col = ArrayStructCol("Factions", "Faction");
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
        var col = new ColumnSpec("Name", "Name", "VARCHAR", "string", [], [], LeafWrite.ReadOnly<IMajorRecord>("test fixture: write capability is not under test"));
        Assert.Empty(Collect(col, "some value"));
    }

    // --- Non-string/non-null elements in formKey array skipped (not throw) ---

    [Fact]
    public void Walk_ArrayFormKey_NonStringElementSkipped()
    {
        var col = ArrayFormKeyCol("Keywords");
        var json = "[1, \"000001:Fallout4.esm\", true]";
        var hits = Collect(col, json);
        Assert.Single(hits);
        Assert.Equal(("keywords[1]", "000001:Fallout4.esm"), hits[0]);
    }

    // --- Non-object elements in struct array skipped (not throw) ---

    [Fact]
    public void Walk_ArrayStruct_NullElementSkipped()
    {
        var col = ArrayStructCol("Factions", "Faction");
        var json = "[null, {\"faction\":\"000010:Plugin.esp\"}]";
        var hits = Collect(col, json);
        Assert.Single(hits);
        Assert.Equal(("factions[1].faction", "000010:Plugin.esp"), hits[0]);
    }

    [Fact]
    public void Walk_ArrayStruct_NonObjectElementSkipped()
    {
        var col = ArrayStructCol("Factions", "Faction");
        var json = "[\"not-an-object\", {\"faction\":\"000010:Plugin.esp\"}]";
        var hits = Collect(col, json);
        Assert.Single(hits);
        Assert.Equal(("factions[1].faction", "000010:Plugin.esp"), hits[0]);
    }

    [Fact]
    public void Walk_ArrayStruct_MissingSubFieldSkipped()
    {
        var col = ArrayStructCol("Factions", "Faction");
        var json = "[{\"rank\":1}]";
        Assert.Empty(Collect(col, json));
    }

    // --- Array with null ElementType (SchemaReflector can produce this for opaque Loqui elements) ---

    [Fact]
    public void Walk_ArrayWithNullElementType_DoesNotCallVisitor()
    {
        var col = new ColumnSpec("items", "items", "JSON", "array", [], [], LeafWrite.ReadOnly<IMajorRecord>("test fixture: write capability is not under test"),
            IsArray: true, ElementType: null);
        var hits = Collect(col, "[\"000001:Fallout4.esm\"]");
        Assert.Empty(hits);
    }

    // --- Depth-2: struct sub-field that is itself a struct containing a formKey ---

    [Fact]
    public void Walk_ArrayStruct_NestedStructSubField_FormKeyReached()
    {
        var innerFk = new FieldMetadata("Target", "formKey", false, [], []);
        var innerStruct = new FieldMetadata("inner", "struct", false, [], [], Fields: [innerFk]);
        var elemMeta = new FieldMetadata("", "struct", false, [], [], Fields: [innerStruct]);
        var col = new ColumnSpec("links", "links", "JSON", "array", [], [], LeafWrite.ReadOnly<IMajorRecord>("test fixture: write capability is not under test"),
            IsArray: true, ElementType: elemMeta);

        var json = "[{\"inner\":{\"target\":\"000001:Plugin.esp\"}}]";
        var hits = Collect(col, json);

        Assert.Single(hits);
        Assert.Equal(("links[0].inner.target", "000001:Plugin.esp"), hits[0]);
    }
}
