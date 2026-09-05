using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using MEditService.Core.Plugins;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using Mutagen.Bethesda;

namespace MEditService.Tests.RealData;

/// <summary>ADR-0032 rule 1: the compare result's per-column values are the stored document's own
/// nodes, keyed by Mutagen's member names. This is the test that says so, over real data rather
/// than a curated record.</summary>
public sealed class WireEqualsDocumentTests : IDisposable
{
    private const string Origin = "Data";
    private const int PerType = 3;

    private static readonly JsonSerializerOptions WireOptions =
        new() { Converters = { new JsonStringEnumConverter() } };

    private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-wire-equals-document-").FullName;
    private readonly LoadOrderMirror _mirror;
    private readonly RecordQueryService _service;
    private readonly PluginKey _plugin = new(CutDownPluginFixture.PluginFileName, Origin);

    public WireEqualsDocumentTests()
    {
        var reflector = SharedSchemaReflector.Instance;
        _mirror = new LoadOrderMirror(new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector)));
        ((ILoadOrderMirror)_mirror).Reconcile(
            _gameDirectory,
            [new LoadOrderEntry(
                CutDownPluginFixture.PluginFileName, CutDownPluginFixture.PluginPath, Origin,
                Slot: 0, Enabled: true, Winning: true)],
            GameRelease.Fallout4);
        _service = new RecordQueryService(_mirror, reflector, new ConflictClassifier());
    }

    public void Dispose()
    {
        _mirror.Dispose();
        try { Directory.Delete(_gameDirectory, recursive: true); }
        catch (IOException) { /* scratch, best-effort */ }
    }

    [Fact(Skip = "Red until the compare wire is the codec document verbatim: today it is a "
        + "projection with snake_case names, a synthesized concrete_type and re-encoded leaves. "
        + "The change that makes the wire the document deletes this Skip.")]
    public void EveryCompareValue_IsTheStoredDocumentsOwnNode()
    {
        var reads = _mirror.Index!.At(RecordRef.Effective);
        var sampled = reads.GetDocuments(_plugin)
            .Where(d => d.RecordType != HeaderIndexer.RecordType)
            .GroupBy(d => d.RecordType, StringComparer.Ordinal)
            .OrderBy(g => g.Key, StringComparer.Ordinal)
            .SelectMany(g => g.OrderBy(d => d.FormKey, StringComparer.Ordinal).Take(PerType))
            .ToList();

        Assert.NotEmpty(sampled);

        var mismatches = new List<string>();
        foreach (var document in sampled)
        {
            var stored = JsonNode.Parse(document.Body!)!.AsObject();
            var compare = _service.GetCompare(document.FormKey);
            Assert.NotNull(compare);

            foreach (var diff in compare!.Diffs)
            {
                var member = stored.TryGetPropertyValue(diff.FieldName, out var node) ? node : null;
                foreach (var (column, value) in diff.Values)
                {
                    if (member == null)
                    {
                        // Absent means default, so a member the document omits may only travel as
                        // nothing; any other value is a second model of it.
                        if (value != null) mismatches.Add($"{document.FormKey} {diff.FieldName} [{column}]: the document has no such member");
                        continue;
                    }

                    var onTheWire = JsonSerializer.SerializeToNode(value, WireOptions);
                    if (!JsonNode.DeepEquals(onTheWire, member))
                    {
                        mismatches.Add($"{document.FormKey} {diff.FieldName} [{column}]: wire "
                            + $"{Short(onTheWire)} vs document {Short(member)}");
                    }
                }
            }
        }

        Assert.True(mismatches.Count == 0,
            $"{mismatches.Count} compare values across {sampled.Count} records are not the stored "
            + $"document's nodes:\n{string.Join("\n", mismatches.Take(20))}");
    }

    private static string Short(JsonNode? node)
    {
        var text = node?.ToJsonString() ?? "null";
        return text.Length <= 80 ? text : text[..80] + "…";
    }
}
