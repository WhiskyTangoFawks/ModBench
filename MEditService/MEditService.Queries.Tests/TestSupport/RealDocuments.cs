using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Index;
using MEditService.LoadOrder;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.TestSupport;

/// <summary>A <see cref="RecordDocument"/> built from the real codec's own text and the real
/// schema's own columns, without a store: a double for the store, not a second definition of a
/// field.</summary>
internal static class RealDocuments
{
    internal static readonly RecordTextCodec Codec = new(NullLogger<RecordTextCodec>.Instance);

    internal static RecordDocument Of(
        IMajorRecordGetter record, PluginCopyKey plugin, int loadOrderIndex, bool isWinner,
        GameRelease release, string? recordType = null, Func<string, RecordLookupEntry?>? resolveFormKey = null)
    {
        var schemas = SharedSchemaReflector.Instance.GetSchemas(release);
        var schema = schemas[recordType ?? RecordTableName.Of(record, schemas)];
        var body = Codec.SerializeToText(record, release);
        using var parsed = JsonDocument.Parse(body);
        var root = parsed.RootElement;

        return new RecordDocument(
            record.FormKey.ToString(), plugin, loadOrderIndex, isWinner, record.EditorID, schema.TableName, body,
            Fields(schema, root, resolveFormKey ?? (_ => null), release),
            IsPartialForm: !schema.IsHeader && PartialFormFlag.IsSet(root, record.GetType()),
            IsPartialFormable: !schema.IsHeader && PartialFormFlag.IsPartialFormable(record.GetType()));
    }

    // Assembles DuckDbRecordIndex.BuildFields' own public calls (DocumentNodes, SyntheticBits,
    // CheckErrorBuilder); it does not redefine what any of them does.
    private static List<FieldValue> Fields(
        RecordTableSchema schema, JsonElement root, Func<string, RecordLookupEntry?> resolveFormKey, GameRelease release)
    {
        ResolvedFormKey? Resolve(string formKey) =>
            resolveFormKey(formKey) is { } entry ? new ResolvedFormKey(entry.RecordType, entry.EditorId) : null;

        var fields = new List<FieldValue>(schema.RecordColumns.Count);
        foreach (var col in schema.RecordColumns)
        {
            var value = col.Synthetic is { } bit
                ? JsonSerializer.SerializeToElement(SyntheticBits.IsSet(root, bit))
                : DocumentNodes.At(root, col.PropertyName);
            var meta = col.ToFieldMetadata();
            fields.Add(new FieldValue(
                meta, value, CheckErrorBuilder.Build(DocumentNodes.VariantFor(meta, root), value, Resolve, release)));
        }
        return fields;
    }
}
