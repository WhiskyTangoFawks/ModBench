using System.Text;
using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Tests.Edits;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;
using Xunit.Abstractions;
using static MEditService.Tests.TestSupport.Envelopes;

namespace MEditService.Tests.RealData;

/// <summary>Whole-document equality per gesture over every record of the real plugin: a set lands
/// as exactly that path, a remove changes exactly that array, and nothing else in the document
/// moves. A document the binary left with a keyed array out of key order is put in key order by
/// its first edit (xEdit's wbArrayS, ADR-0032), so each is settled once and the gestures run from
/// there. The header takes its one synthetic member.</summary>
public sealed class DocumentEditRealDataTests(CutDownPluginFixture fixture, ITestOutputHelper output)
    : IClassFixture<CutDownPluginFixture>
{
    private static readonly IReadOnlyDictionary<string, RecordTableSchema> Schemas =
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);

    [Fact]
    public void EveryRecord_SetOfOneMember_ChangesExactlyThatPath()
    {
        var reads = fixture.Repo.At(RecordRef.Effective);
        var documents = reads.GetDocuments(new PluginKey(CutDownPluginFixture.PluginFileName, "Data"));
        Assert.True(documents.Count > 3000, $"Expected the whole cut-down plugin to be indexed; got {documents.Count} documents.");

        var failures = new List<string>();
        var removes = 0;
        var settledIntoKeyOrder = 0;
        foreach (var document in documents)
        {
            var schema = Schemas[document.RecordType];
            var before = document.Body!;
            if (!schema.IsHeader)
            {
                var identity = DocumentEdits.Apply(
                    before, schema, SetAt(Json(JsonSerializer.Serialize(document.EditorId)), Member("EditorID")), out var settled, reads.Resolve);
                if (identity != null) { failures.Add($"{document.RecordType} {document.FormKey}: settling refused, {identity.Refusal} {identity.Message}"); continue; }
                if (settled != before) settledIntoKeyOrder++;
                before = settled;
            }
            var (envelope, path) = schema.IsHeader
                ? (SetAt(Json("true"), Member("IsSmallMaster")), "ModHeader.Flags")
                : (SetAt(Json("\"MEditProbe\""), Member("EditorID")), "EditorID");

            var refusal = DocumentEdits.Apply(before, schema, envelope, out var after, reads.Resolve);
            if (refusal != null) { failures.Add($"{document.RecordType} {document.FormKey}: {refusal.Refusal} {refusal.Message}"); continue; }
            failures.AddRange(Strays(document, before, after, path));

            // The first populated positional array loses its first element and nothing else moves.
            var array = schema.RecordColumns.FirstOrDefault(c => c.IsArray && c.KeyMembers == null && c.Synthetic == null
                && DocumentNodes.At(JsonDocument.Parse(before).RootElement, c.PropertyName) is { ValueKind: JsonValueKind.Array } a && a.GetArrayLength() > 0);
            if (array == null || schema.IsHeader) continue;
            removes++;
            var removed = DocumentEdits.Apply(before, schema, RemoveAt(Member(array.Name), At(0)), out var afterRemove, reads.Resolve);
            if (removed != null) { failures.Add($"{document.RecordType} {document.FormKey} remove {array.Name}[0]: {removed.Refusal} {removed.Message}"); continue; }
            failures.AddRange(Strays(document, before, afterRemove, array.Name));
        }

        output.WriteLine($"{documents.Count} records set, {removes} removed an element, {settledIntoKeyOrder} were first put in key order.");
        Assert.True(failures.Count == 0, $"{failures.Count} gestures did not land as exactly their path:\n{string.Join("\n", failures.Take(20))}");
    }

    private static IEnumerable<string> Strays(RecordDocument document, string before, string after, string path)
    {
        var diffs = ConditionEditTests.DocumentDiff(before, after);
        if (diffs.Count == 0) yield return $"{document.RecordType} {document.FormKey}: nothing changed at {path}";
        foreach (var stray in diffs.Where(d => !d.StartsWith(path, StringComparison.Ordinal)))
            yield return $"{document.RecordType} {document.FormKey}: {stray}";
    }

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;
}
