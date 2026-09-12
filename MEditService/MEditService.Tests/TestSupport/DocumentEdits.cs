using System.Text;
using MEditService.Commands.Edits;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.TestSupport;

/// <summary>The document-edit seam with a string fixture: text and metadata in, text or a refusal
/// out, the codec as the round trip and no index behind it.</summary>
internal static class DocumentEdits
{
    internal static readonly RecordTextCodec Codec = new(NullLogger<RecordTextCodec>.Instance);

    internal static RecordEditResult? Apply(
        string text, RecordTableSchema schema, RecordEditEnvelope envelope, out string written,
        IReadOnlyList<PathHop>? prefix = null, string? ownerRecordType = null)
    {
        var recordType = ownerRecordType ?? schema.TableName;
        return DocumentEdit.Patch(
            new DocumentEditRequest(
                text, prefix ?? [], schema, envelope, GameRelease.Fallout4,
                patched => schema.IsHeader && prefix is null or { Count: 0 }
                    ? Encoding.UTF8.GetString(HeaderDocument.Write(HeaderDocument.Read(Encoding.UTF8.GetBytes(patched))))
                    : RoundTrip(patched, recordType)),
            out written);
    }

    internal static string RoundTrip(string text, string recordType) => Codec.RoundTrip(text, GameRelease.Fallout4, recordType);

    internal static string Serialize(IMajorRecordGetter record) =>
        Encoding.UTF8.GetString(Codec.SerializeToBytesAsync(record, GameRelease.Fallout4).GetAwaiter().GetResult());
}
