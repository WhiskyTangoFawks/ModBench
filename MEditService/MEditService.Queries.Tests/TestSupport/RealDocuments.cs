using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Queries.Tests.TestSupport;

/// <summary>A <see cref="RecordDocument"/> hand-built from the real codec's own text and the named
/// fields a test reads, never a loop over every column a record type happens to have.</summary>
internal static class RealDocuments
{
    private static readonly RecordTextCodec Codec = new(NullLogger<RecordTextCodec>.Instance);

    internal static string BodyOf(IMajorRecordGetter record, GameRelease release) => Codec.SerializeToText(record, release);

    // The one column a test asserts on, by name — the same public calls DocumentNodes,
    // SyntheticBits and CheckErrorBuilder that the store itself calls, aimed at a single field
    // rather than every field a schema declares.
    internal static FieldValue FieldOf(
        RecordTableSchema schema, JsonElement root, string columnName, GameRelease release,
        Func<string, RecordLookupEntry?>? resolveFormKey = null)
    {
        var col = schema.RecordColumns.Single(c => c.Name == columnName);
        var value = col.Synthetic is { } bit
            ? JsonSerializer.SerializeToElement(SyntheticBits.IsSet(root, bit))
            : DocumentNodes.At(root, col.PropertyName);
        var meta = col.ToFieldMetadata();

        ResolvedFormKey? Resolve(string formKey) =>
            (resolveFormKey ?? (_ => null))(formKey) is { } entry ? new ResolvedFormKey(entry.RecordType, entry.EditorId) : null;

        return new FieldValue(meta, value, CheckErrorBuilder.Build(DocumentNodes.VariantFor(meta, root), value, Resolve, release));
    }

    // fieldNames names the columns the test reads; a schema lacking one of them is skipped for it.
    internal static RecordDocument Of(
        IMajorRecordGetter record, PluginAddress plugin, int loadOrderIndex, bool isWinner, GameRelease release,
        string recordType, IReadOnlyList<string> fieldNames, Func<string, RecordLookupEntry?>? resolveFormKey = null)
    {
        var schema = SharedSchemaReflector.Instance.GetSchemas(release)[recordType];
        var body = BodyOf(record, release);
        using var parsed = JsonDocument.Parse(body);
        var root = parsed.RootElement;
        var fields = fieldNames
            .Where(n => schema.RecordColumns.Any(c => c.Name == n))
            .Select(n => FieldOf(schema, root, n, release, resolveFormKey))
            .ToList();

        return new RecordDocument(
            record.FormKey.ToString(), plugin, loadOrderIndex, isWinner, record.EditorID, recordType, body, fields,
            IsPartialForm: !schema.IsHeader && PartialFormFlag.IsSet(root, record.GetType()),
            IsPartialFormable: !schema.IsHeader && PartialFormFlag.IsPartialFormable(record.GetType()));
    }
}
