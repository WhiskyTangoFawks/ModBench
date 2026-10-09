using System.Text;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Codec.Tests.TestSupport;

/// <summary>An edit by path over a record's text, as the write side makes it: located, applied, written
/// back through the codec, and the codec's text checked for what it dropped.</summary>
internal static class DocumentEditing
{
    private static readonly IReadOnlyDictionary<string, RecordTableSchema> Schemas =
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);

    internal sealed record Outcome(EditFailure? Failure, string? Dropped, string? Text);

    internal static DocumentHop Member(string name) => new(name, null);

    internal static DocumentHop At(int index) => new(null, index);

    internal static Outcome Edit(string text, string table, EditOp op, string? value, params DocumentHop[] path)
    {
        var schema = Schemas[table];
        if (!Document.TryRead(text, out var record, out var whyNot)) throw new InvalidOperationException(whyNot);
        if (DocumentEdit.Locate(record, schema, op, path, out var edit) is { } unaddressed) return new(unaddressed, null, null);
        if (edit.Require().Apply(value, out var patch) is { } failure) return new(failure, null, null);
        var patched = patch.Require().Document;
        var written = WrittenBack(patched.Text, schema);
        if (!Document.TryRead(written, out var writtenDocument, out whyNot)) throw new InvalidOperationException(whyNot);
        return new(null, patch.Require().FirstDropped(patched, writtenDocument), written);
    }

    /// <summary>The codec's text of an edit that must succeed.</summary>
    internal static string Edited(string text, string table, EditOp op, string? value, params DocumentHop[] path)
    {
        var outcome = Edit(text, table, op, value, path);
        if (outcome.Failure is { } failure) throw new InvalidOperationException($"Expected the edit to be made: {failure}");
        if (outcome.Dropped is { } dropped) throw new InvalidOperationException($"Expected the codec to keep '{dropped}'.");
        return outcome.Text.Require();
    }

    internal static EditFailure Failure(string text, string table, EditOp op, string? value, params DocumentHop[] path) =>
        Edit(text, table, op, value, path).Failure ?? throw new InvalidOperationException("Expected the edit to fail.");

    private static string WrittenBack(string patched, RecordTableSchema schema) =>
        schema.IsHeader
            ? Encoding.UTF8.GetString(HeaderDocument.Write(HeaderDocument.Read(Encoding.UTF8.GetBytes(patched))))
            : RecordTextCodec.RoundTrip(patched, GameRelease.Fallout4, schema.TableName);
}
