using System.Text;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Codec.Tests.TestSupport;

/// <summary>An edit by path over a record's text, as the write side makes it: located, applied, written
/// back through the codec, and checked for what the codec dropped and a synthetic member changed aside.</summary>
internal static class DocumentEditing
{
    private static readonly IReadOnlyDictionary<string, RecordTableSchema> Schemas =
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);

    internal sealed record Outcome(EditFailure? Failure, string? Dropped, string? ChangedAside, string? Text);

    internal static DocumentHop Member(string name) => new(name, null);

    internal static DocumentHop At(int index) => new(null, index);

    internal static Outcome Edit(string text, string table, EditOp op, string? value, params DocumentHop[] path)
    {
        var schema = Schemas[table];
        var record = Document.Parse(text);
        if (DocumentEdit.Locate(record, schema, op, path, out var located) is { } unaddressed) return new(unaddressed, null, null, null);
        var edit = located.Require();
        if (edit.Apply(value, out var applied) is { } failure) return new(failure, null, null, null);
        var patch = applied.Require();
        var written = WrittenBack(patch.Document.Text, schema);
        var after = Document.Parse(written);
        var changedAside = schema.RecordColumns
            .Where(column => column.Synthetic is { } bit && column != edit.Column && SyntheticBits.IsSet(record, bit) != SyntheticBits.IsSet(after, bit))
            .Select(column => column.Name)
            .FirstOrDefault();
        return new(null, patch.FirstDropped(patch.Document, after), changedAside, written);
    }

    /// <summary>The codec's text of an edit that must succeed.</summary>
    internal static string Edited(string text, string table, EditOp op, string? value, params DocumentHop[] path)
    {
        var outcome = Edit(text, table, op, value, path);
        if (outcome.Failure is { } failure) throw new InvalidOperationException($"Expected the edit to be made: {failure}");
        if (outcome.Dropped is { } dropped) throw new InvalidOperationException($"Expected the codec to keep '{dropped}'.");
        if (outcome.ChangedAside is { } aside) throw new InvalidOperationException($"Expected the edit to leave '{aside}' as it was.");
        return outcome.Text.Require();
    }

    internal static EditFailure Failure(string text, string table, EditOp op, string? value, params DocumentHop[] path) =>
        Edit(text, table, op, value, path).Failure ?? throw new InvalidOperationException("Expected the edit to fail.");

    private static string WrittenBack(string patched, RecordTableSchema schema) =>
        schema.IsHeader
            ? Encoding.UTF8.GetString(HeaderDocument.Write(HeaderDocument.Read(Encoding.UTF8.GetBytes(patched))))
            : RecordTextCodec.RoundTrip(patched, GameRelease.Fallout4, schema.TableName);
}
