using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using MEditService.Core.Plugins;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using Mutagen.Bethesda;

namespace MEditService.Tests.RealData;

/// <summary>The cut-down plugin behind a load order, which the compare read requires and
/// <see cref="CutDownPluginFixture"/> does not carry; one index, built once for the class.</summary>
public sealed class CutDownPluginCompareFixture : IDisposable
{
    public const string Origin = "Data";

    public LoadOrderMirror Mirror { get; }
    public RecordQueryService Compare { get; }
    public PluginKey Plugin { get; } = new(CutDownPluginFixture.PluginFileName, Origin);

    private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-wire-equals-document-").FullName;

    public CutDownPluginCompareFixture()
    {
        var reflector = SharedSchemaReflector.Instance;
        Mirror = new LoadOrderMirror(new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector)));
        ((ILoadOrderMirror)Mirror).Reconcile(
            _gameDirectory,
            [new LoadOrderEntry(
                CutDownPluginFixture.PluginFileName, CutDownPluginFixture.PluginPath, Origin,
                Slot: 0, Enabled: true, Winning: true)],
            GameRelease.Fallout4);
        Compare = new RecordQueryService(Mirror, reflector, new ConflictClassifier());
    }

    public void Dispose()
    {
        Mirror.Dispose();
        try { Directory.Delete(_gameDirectory, recursive: true); }
        catch (IOException) { /* scratch, best-effort */ }
    }
}

public sealed class WireEqualsDocumentTests(CutDownPluginCompareFixture fixture)
    : IClassFixture<CutDownPluginCompareFixture>
{
    private static readonly JsonSerializerOptions WireOptions =
        new() { Converters = { new JsonStringEnumConverter() } };

    [Fact(Skip = "Red until the compare wire is the codec document verbatim: today it is a "
        + "projection with snake_case names, a synthesized concrete_type and re-encoded leaves. "
        + "Making the wire the document (debt #722) deletes this Skip.")]
    public void EveryCompareValue_IsTheStoredDocumentsOwnNode()
    {
        var reads = fixture.Mirror.Index!.At(RecordRef.Effective);
        var formKeys = GoldenFormKeys();

        Assert.NotEmpty(formKeys);

        var mismatches = new List<string>();
        foreach (var formKey in formKeys)
        {
            var document = reads.GetDocument(formKey, fixture.Plugin);
            Assert.NotNull(document);
            var stored = JsonNode.Parse(Assert.IsType<string>(document!.Body));
            var compare = fixture.Compare.GetCompare(formKey);
            Assert.NotNull(compare);

            foreach (var diff in compare!.Diffs) Collect(diff, stored, formKey, mismatches);
        }

        Assert.True(mismatches.Count == 0,
            $"{mismatches.Count} compare values across {formKeys.Count} records are not the stored "
            + $"document's nodes:\n{string.Join("\n", mismatches.Take(20))}");
    }

    private static void Collect(FieldDiff diff, JsonNode? parent, string path, List<string> mismatches)
    {
        var node = Resolve(parent, diff.FieldName);
        var here = $"{path}.{diff.FieldName}";

        foreach (var (column, value) in diff.Values)
        {
            if (node == null)
            {
                // Absent means default, so a member the document omits may only travel as nothing;
                // any other value is a second model of it.
                if (value != null) mismatches.Add($"{here} [{column}]: the document has no such node");
                continue;
            }

            var onTheWire = JsonSerializer.SerializeToNode(value, WireOptions);
            if (!JsonNode.DeepEquals(onTheWire, node))
                mismatches.Add($"{here} [{column}]: wire {Short(onTheWire)} vs document {Short(node)}");
        }

        foreach (var child in diff.Children ?? []) Collect(child, node, here, mismatches);
    }

    private static JsonNode? Resolve(JsonNode? parent, string name) => parent switch
    {
        JsonObject o => o.TryGetPropertyValue(name, out var member) ? member : null,
        JsonArray a when ElementIndex(name) is { } i && i >= 0 && i < a.Count => a[i],
        _ => null,
    };

    // An array child is labelled by its position; every other label is a member name.
    private static int? ElementIndex(string label) =>
        label.StartsWith('[') && label.EndsWith(']')
        && int.TryParse(label[1..^1], NumberStyles.None, CultureInfo.InvariantCulture, out var index)
            ? index
            : null;

    private static IReadOnlyList<string> GoldenFormKeys()
    {
        var golden = Path.Combine(AppContext.BaseDirectory, "TestData", "goldens", "realdata-record-detail.json");
        using var document = JsonDocument.Parse(File.ReadAllText(golden));
        return [.. document.RootElement.EnumerateObject()
            .SelectMany(recordType => recordType.Value.EnumerateArray())
            .Select(record => record.GetProperty("FormKey").GetString()!)
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal)];
    }

    private static string Short(JsonNode? node)
    {
        var text = node?.ToJsonString() ?? "null";
        return text.Length <= 80 ? text : text[..80] + "…";
    }
}
