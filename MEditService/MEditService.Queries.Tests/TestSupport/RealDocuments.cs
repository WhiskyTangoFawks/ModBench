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

/// <summary>A <see cref="RecordDocument"/> read from the real codec's own text under the schema's
/// own projection, as the index reads one. Whether it wins is the fake reads' to say.</summary>
internal static class RealDocuments
{
    private static readonly RecordTextCodec Codec = new(NullLogger<RecordTextCodec>.Instance);

    internal static string BodyOf(IMajorRecordGetter record, GameRelease release) => Codec.SerializeToText(record, release);

    internal static RecordDocument Of(
        IMajorRecordGetter record, PluginAddress plugin, int loadOrderIndex, GameRelease release,
        Func<string, RecordLookupEntry?>? resolveFormKey = null)
    {
        var schemas = SharedSchemaReflector.Instance.GetSchemas(release);
        return FromBody(
            record.FormKey.ToString(), plugin, loadOrderIndex, record.EditorID, BodyOf(record, release),
            schemas[RecordTableName.Of(record, schemas)], resolveFormKey ?? (_ => null), release, parseDiagnosis: null);
    }

    internal static RecordDocument FromText(
        string text, string formKey, PluginAddress plugin, int loadOrderIndex, string recordType,
        Func<string, RecordLookupEntry?> resolveFormKey)
    {
        var release = GameRelease.Fallout4;
        var (body, editorId, parseDiagnosis) = CallerText.Read(text);
        return FromBody(
            formKey, plugin, loadOrderIndex, editorId, body,
            SharedSchemaReflector.Instance.GetSchemas(release)[recordType], resolveFormKey, release, parseDiagnosis);
    }

    private static RecordDocument FromBody(
        string formKey, PluginAddress plugin, int loadOrderIndex, string? editorId, string body,
        RecordTableSchema schema, Func<string, RecordLookupEntry?> resolveFormKey, GameRelease release, string? parseDiagnosis)
    {
        using var parsed = JsonDocument.Parse(body);
        var root = parsed.RootElement;
        var fields = schema.FieldsOf(
            root, link => resolveFormKey(link) is { } entry ? new ResolvedFormKey(entry.RecordType, entry.EditorId) : null, release);
        return new RecordDocument(
            formKey, plugin, loadOrderIndex, IsWinner: false, editorId, schema.TableName, body, fields,
            schema.IsPartialForm(root), parseDiagnosis);
    }
}
