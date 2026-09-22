using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Tests;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Tests.Schema;

// The shared kernel's answer to "which FormKeys does this document reference", driven the way every
// caller drives it: a document and the schema for its record type, nothing else.
public class FormReferenceCollectorTests
{
    private static ColumnSpec Column(SubFieldSpec field) => new(field, field.Name, "JSON");

    private static RecordTableSchema SchemaOf(params ColumnSpec[] columns) =>
        new()
        {
            TableName = "test",
            DisplayName = "Test",
            RecordType = typeof(IMajorRecordGetter),
            RecordColumns = columns,
        };

    private static ColumnSpec ScalarFormKeyCol(string name) =>
        new(new SubFieldSpec(name, "formKey", [], []), name, "VARCHAR");

    private static ColumnSpec ArrayFormKeyCol(string name) =>
        Column(new SubFieldSpec(name, "array", [], [], ElementSpec: new SubFieldSpec(name, "formKey", [], [])));

    private static ColumnSpec ArrayStructCol(string name, params string[] fkSubFields) =>
        Column(new SubFieldSpec(name, "array", [], [],
            ElementSpec: new SubFieldSpec(name, "struct", [], [],
                SubFields: [.. fkSubFields.Select(f => new SubFieldSpec(f, "formKey", [], []))])));

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
        results.AddRange(FormReferences.Collect(root.RootElement, SchemaOf(col)).Select(r => (r.FieldPath, r.TargetFormKey)));
        return results;
    }

    // --- Case 1: scalar formKey ---

    [Fact]
    public void Collect_ScalarFormKey_StringInput_IsYielded()
    {
        var col = ScalarFormKeyCol("Race");
        var hits = Collect(col, "000001:Fallout4.esm");
        Assert.Single(hits);
        Assert.Equal(("Race", "000001:Fallout4.esm"), hits[0]);
    }

    [Fact]
    public void Collect_ScalarFormKey_JsonElementInput_IsYielded()
    {
        var col = ScalarFormKeyCol("Race");
        var je = JsonDocument.Parse("\"000002:Plugin.esp\"").RootElement.Clone();
        var hits = Collect(col, je);
        Assert.Single(hits);
        Assert.Equal(("Race", "000002:Plugin.esp"), hits[0]);
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

    // --- Case 2: array of formKey ---

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
    public void Collect_ArrayFormKey_JsonElementInput_IndexedPaths()
    {
        var col = ArrayFormKeyCol("Keywords");
        var je = JsonDocument.Parse("[\"000001:Fallout4.esm\",\"000002:Plugin.esp\"]").RootElement.Clone();
        var hits = Collect(col, je);
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

    // --- Case 3: array of struct with formKey subfields ---

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
    public void Collect_ArrayStruct_JsonElementInput_SubFieldPaths()
    {
        var col = ArrayStructCol("Factions", "Faction");
        var je = JsonDocument.Parse("[{\"Faction\":\"000010:Plugin.esp\",\"Rank\":1}]").RootElement.Clone();
        var hits = Collect(col, je);
        Assert.Single(hits);
        Assert.Equal(("Factions[0].Faction", "000010:Plugin.esp"), hits[0]);
    }

    [Fact]
    public void Collect_ArrayStruct_NonFormKeySubFieldsIgnored()
    {
        var col = ArrayStructCol("Factions", "Faction"); // "Rank" is not in fkSubFields
        var json = "[{\"Faction\":\"000010:Plugin.esp\",\"Rank\":1}]";
        var hits = Collect(col, json);
        Assert.Single(hits);
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

    // --- Unrecognized ApiType ---

    [Fact]
    public void Collect_UnknownApiType_IsNotYielded()
    {
        var col = new ColumnSpec(new SubFieldSpec("Name", "string", [], []), "Name", "VARCHAR");
        Assert.Empty(Collect(col, "some value"));
    }

    // --- Non-string/non-null elements in formKey array skipped (not throw) ---

    [Fact]
    public void Collect_ArrayFormKey_NonStringElementSkipped()
    {
        var col = ArrayFormKeyCol("Keywords");
        var json = "[1, \"000001:Fallout4.esm\", true]";
        var hits = Collect(col, json);
        Assert.Single(hits);
        Assert.Equal(("Keywords[1]", "000001:Fallout4.esm"), hits[0]);
    }

    // --- Non-object elements in struct array skipped (not throw) ---

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

    // --- Array with null ElementType (SchemaReflector can produce this for opaque Loqui elements) ---

    [Fact]
    public void Collect_ArrayWithNullElementType_IsNotYielded()
    {
        var col = Column(new SubFieldSpec("items", "array", [], [], ElementSpec: null));
        var hits = Collect(col, "[\"000001:Fallout4.esm\"]");
        Assert.Empty(hits);
    }

    // --- Depth-2: struct sub-field that is itself a struct containing a formKey ---

    [Fact]
    public void Collect_ArrayStruct_NestedStructSubField_FormKeyReached()
    {
        var innerFk = new SubFieldSpec("Target", "formKey", [], []);
        var innerStruct = new SubFieldSpec("inner", "struct", [], [], SubFields: [innerFk]);
        var elemSpec = new SubFieldSpec("", "struct", [], [], SubFields: [innerStruct]);
        var col = Column(new SubFieldSpec("links", "array", [], [], ElementSpec: elemSpec));

        var json = "[{\"inner\":{\"Target\":\"000001:Plugin.esp\"}}]";
        var hits = Collect(col, json);

        Assert.Single(hits);
        Assert.Equal(("links[0].inner.Target", "000001:Plugin.esp"), hits[0]);
    }

    // --- The whole record, the way every caller asks: one document, one schema ---

    [Fact]
    public void Collect_ARecordWithANestedStruct_AListOfLinks_AndAUnionField_YieldsEachTargetOnce()
    {
        var nested = Column(new SubFieldSpec("Ownership", "struct", [], [],
            SubFields: [new SubFieldSpec("Owner", "struct", [], [],
                SubFields: [new SubFieldSpec("Faction", "formKey", [], [])])]));
        var list = Column(new SubFieldSpec("Keywords", "array", [], [],
            ElementSpec: new SubFieldSpec("Keywords", "formKey", [], [])));
        // A union member: the leaf named by the document's own discriminator decides the shape, so
        // the link under the named leaf is reached and the other leaf's is not.
        var union = Column(new SubFieldSpec("Value", "struct", [], [], Variants: new Dictionary<string, SubFieldSpec>
        {
            ["ObjectValue"] = new SubFieldSpec("Value", "struct", [], [],
                SubFields: [new SubFieldSpec("Object", "formKey", [], [])]),
            ["StringValue"] = new SubFieldSpec("Value", "struct", [], [],
                SubFields: [new SubFieldSpec("Text", "string", [], [])]),
        }));

        using var document = JsonDocument.Parse($$"""
            {
              "{{LoquiUnions.UnionTypeDiscriminator}}": "ObjectValue",
              "Ownership": { "Owner": { "Faction": "000001:A.esp" } },
              "Keywords": ["000002:A.esp", "000003:A.esp"],
              "Value": { "Object": "000004:A.esp" }
            }
            """);

        var refs = FormReferences.Collect(document.RootElement, SchemaOf(nested, list, union));

        Assert.Equal(
            [("Ownership.Owner.Faction", "000001:A.esp"),
             ("Keywords[0]", "000002:A.esp"),
             ("Keywords[1]", "000003:A.esp"),
             ("Value.Object", "000004:A.esp")],
            refs.Select(r => (r.FieldPath, r.TargetFormKey)));
    }

    [Fact]
    public void Collect_TheHeader_YieldsNoLinks_ItsMastersNamePluginsNotRecords()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Masters.esp"), Fallout4Release.Fallout4);
        mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Fallout4.esm") });
        var header = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4)[PluginHeader.RecordType];

        using var document = JsonDocument.Parse(HeaderDocument.Write(mod));

        var masters = DocumentNodes.At(document.RootElement, $"ModHeader.{nameof(mod.ModHeader.MasterReferences)}");
        Assert.NotNull(masters);
        Assert.Equal(
            ["Fallout4.esm"],
            masters.Value.EnumerateArray().Select(m => m.GetProperty("Master").GetString()));
        // The schema types a master as the plugin name it is, so the collector reaches no leaf: the
        // references table has never held a row sourced at a header.
        Assert.Empty(FormReferences.Collect(document.RootElement, header));
    }
}
