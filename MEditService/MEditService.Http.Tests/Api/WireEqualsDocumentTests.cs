using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Api;

public sealed class WireEqualsDocumentTests(LoadedApiFixture<CutDownPluginApiFixture> loaded)
    : IClassFixture<LoadedApiFixture<CutDownPluginApiFixture>>
{
    private static readonly JsonSerializerOptions MetaOptions = new(JsonSerializerDefaults.Web);
    private readonly HttpClient _client = loaded.Client;

    [Theory]
    [MemberData(nameof(GoldenFormKeys))]
    public async Task EveryCompareValue_IsTheOverridesOwnField(string formKey)
    {
        var compare = await _client.Compare(formKey);
        var independentRecordRead = await _client.Record(formKey);
        var fields = independentRecordRead.GetProperty("fields");

        var metadata = new Dictionary<string, FieldMetadata>(StringComparer.Ordinal);
        var fieldsByName = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        foreach (var field in fields.EnumerateArray())
        {
            var name = field.GetProperty("metadata").GetProperty("name").GetString().Require();
            metadata[name] = field.GetProperty("metadata").Deserialize<FieldMetadata>(MetaOptions).Require();
            fieldsByName[name] = field.GetProperty("value");
        }

        var mismatches = new List<string>();
        foreach (var diff in compare.GetProperty("diffs").EnumerateArray())
        {
            var name = diff.GetProperty("fieldName").GetString().Require();
            var root = fieldsByName.TryGetValue(name, out var value) && value.ValueKind != JsonValueKind.Null
                ? value : (JsonElement?)null;
            Collect(diff, root, metadata.GetValueOrDefault(name), formKey, mismatches);
        }

        var onTheWire = compare.GetProperty("diffs").EnumerateArray()
            .Select(d => d.GetProperty("fieldName").GetString().Require()).ToHashSet(StringComparer.Ordinal);
        foreach (var (name, value) in fieldsByName)
            if (value.ValueKind != JsonValueKind.Null && !onTheWire.Contains(name))
                mismatches.Add($"{formKey}.{name}: the field read carries this node and compare has no such field");

        Assert.True(mismatches.Count == 0,
            $"{mismatches.Count} compare values of {formKey} are not the field read's own nodes:\n"
            + string.Join("\n", mismatches.Take(20)));
    }

    private static void Collect(
        JsonElement diff, JsonElement? fieldReadNodeAtThisPath, FieldMetadata? shapeOfThatNode, string path, List<string> mismatches)
    {
        var fieldName = diff.GetProperty("fieldName").GetString().Require();
        var here = $"{path}.{fieldName}";
        CompareValues(diff, fieldReadNodeAtThisPath, here, mismatches);

        var shape = shapeOfThatNode == null || fieldReadNodeAtThisPath == null
            ? shapeOfThatNode
            : DocumentNodes.VariantFor(shapeOfThatNode, fieldReadNodeAtThisPath);
        if (!diff.TryGetProperty("children", out var children) || children.ValueKind != JsonValueKind.Array) return;

        foreach (var child in children.EnumerateArray())
        {
            var childName = child.GetProperty("fieldName").GetString().Require();
            Collect(child, Resolve(fieldReadNodeAtThisPath, child, childName), ChildMeta(shape, childName), here, mismatches);
        }
    }

    private static void CompareValues(JsonElement diff, JsonElement? node, string here, List<string> mismatches)
    {
        foreach (var column in diff.GetProperty("values").EnumerateObject())
        {
            var here2 = $"{here} [{column.Name}]";
            if (node is not { } n)
            {
                if (column.Value.ValueKind != JsonValueKind.Null) mismatches.Add($"{here2}: the field read has no such node");
                continue;
            }
            if (!JsonElement.DeepEquals(column.Value, n))
                mismatches.Add($"{here2}: diff {Short(column.Value)} vs field {Short(n)}");
        }
    }

    private static FieldMetadata? ChildMeta(FieldMetadata? owner, string label) =>
        owner?.Type == "array" ? owner.ElementType : owner?.Fields?.FirstOrDefault(f => f.Name == label);

    private static JsonElement? Resolve(JsonElement? parent, JsonElement child, string name)
    {
        if (parent is not { } p) return null;
        if (p.ValueKind == JsonValueKind.Object)
            return p.TryGetProperty(name, out var member) ? member : null;
        if (p.ValueKind != JsonValueKind.Array || !child.TryGetProperty("indexes", out var indexes)
            || indexes.ValueKind != JsonValueKind.Object)
            return null;
        var index = indexes.EnumerateObject().Single().Value.GetInt32();
        return index < p.GetArrayLength() ? p[index] : null;
    }

    public static TheoryData<string> GoldenFormKeys()
    {
        var golden = Path.Combine(AppContext.BaseDirectory, "TestData", "goldens", "realdata-record-detail.json");
        using var document = JsonDocument.Parse(File.ReadAllText(golden));
        return new(document.RootElement.EnumerateObject()
            .SelectMany(recordType => recordType.Value.EnumerateArray())
            .Select(record => DocumentNodes.StringValueOf(record.GetProperty("FormKey")))
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal));
    }

    private static string Short(JsonElement node)
    {
        var text = node.GetRawText();
        return text.Length <= 80 ? text : text[..80] + "…";
    }
}
