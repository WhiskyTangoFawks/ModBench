using System.Text;
using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using MEditService.Core.Source;
using MEditService.Tests.Edits;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;
using Xunit.Abstractions;
using static MEditService.Tests.TestSupport.Envelopes;

namespace MEditService.Tests.RealData;

/// <summary>Whole-document equality per gesture over every record of the real plugin. A keyed
/// array the binary left out of key order is sorted by its first edit (ADR-0005), so each document
/// is settled once first.</summary>
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
        var gestures = 0;
        var settledIntoKeyOrder = 0;
        foreach (var document in documents)
        {
            var schema = Schemas[document.RecordType];
            var before = document.Body!;
            if (!schema.IsHeader)
            {
                var identity = DocumentEdits.Apply(
                    before, schema, SetAt(Json(JsonSerializer.Serialize(document.EditorId)), Member("EditorID")), out var settled);
                if (identity != null) { failures.Add($"{document.RecordType} {document.FormKey}: settling refused, {identity.Refusal} {identity.Message}"); continue; }
                if (settled != before) settledIntoKeyOrder++;
                before = settled;
            }
            var (envelope, path) = schema.IsHeader
                ? (SetAt(Json("true"), Member("IsSmallMaster")), "ModHeader.Flags")
                : (SetAt(Json("\"MEditProbe\""), Member("EditorID")), "EditorID");

            var refusal = DocumentEdits.Apply(before, schema, envelope, out var after);
            if (refusal != null) { failures.Add($"{document.RecordType} {document.FormKey}: {refusal.Refusal} {refusal.Message}"); continue; }
            failures.AddRange(Strays(document, before, after, path));

            if (schema.IsHeader) continue;
            var root = JsonDocument.Parse(before).RootElement;
            foreach (var (gesture, edited) in Gestures(schema, root))
            {
                gestures++;
                var refused = DocumentEdits.Apply(before, schema, gesture, out var landed);
                if (refused != null) { failures.Add($"{document.RecordType} {document.FormKey} {gesture.Op} {edited}: {refused.Refusal} {refused.Message}"); continue; }
                failures.AddRange(Strays(document, before, landed, edited));
            }
        }

        output.WriteLine($"{documents.Count} records set, {gestures} further gestures, {settledIntoKeyOrder} were first put in key order.");
        Assert.True(gestures > 2000, $"the fixture should offer thousands of array and union gestures; it offered {gestures}");
        Assert.True(failures.Count == 0, $"{failures.Count} gestures did not land as exactly their path:\n{string.Join("\n", failures.Take(20))}");
    }

    // Every gesture the record's shape offers, named by the path it may change: a remove by
    // position or key, an add, a move, a leaf switch on the first union element, and a function
    // change (the cascade).
    private static IEnumerable<(RecordEditEnvelope Gesture, string Path)> Gestures(RecordTableSchema schema, JsonElement root)
    {
        // A container's child slots are structural gestures the edit service refuses up front, not
        // fields, so they offer nothing here.
        var childSlots = RecordTypeDispatch.For(GameRelease.Fallout4).ConcreteFor(schema.TableName) is { } concrete
            ? ContainerChildFields.EnumerateChildFieldsFor(concrete) ?? []
            : [];
        foreach (var column in schema.RecordColumns.Where(c => c.Field.IsArray && c.Synthetic == null && c.ReadOnlyReason == null && !childSlots.Contains(c.Name)))
        {
            if (DocumentNodes.At(root, column.PropertyName) is not { ValueKind: JsonValueKind.Array } array || array.GetArrayLength() == 0) continue;
            var meta = DocumentNodes.VariantFor(column.ToFieldMetadata(), root);
            var first = array[0];
            if (meta.KeyMembers is { } keyMembers)
            {
                yield return (RemoveAt(Member(column.Name), Key(ElementKey.Of(first, keyMembers, meta.ElementType).Text)), column.Name);
            }
            else
            {
                yield return (RemoveAt(Member(column.Name), At(0)), column.Name);
                yield return (AddAt(Member(column.Name)), column.Name);
                // Moving one of two identical elements changes nothing, which is not a stray.
                if (array.GetArrayLength() > 1 && first.GetRawText() != array[1].GetRawText())
                    yield return (MoveTo(1, Member(column.Name), At(0)), column.Name);
            }

            var discriminator = meta.ElementType?.Fields?.FirstOrDefault(f => f.IsDiscriminator);
            if (discriminator != null && first.ValueKind == JsonValueKind.Object
                && first.TryGetProperty(discriminator.Name, out var leaf)
                && discriminator.EnumMembers.FirstOrDefault(m => m.Value != leaf.GetString()) is { } other)
            {
                yield return (SetAt(Json(JsonSerializer.Serialize(other.Value)), Member(column.Name), At(0), Member(discriminator.Name)), $"{column.Name}[0]");
            }

            if (column.Name == "Conditions" && first.ValueKind == JsonValueKind.Object
                && first.TryGetProperty("Data", out var data) && data.TryGetProperty("Function", out var function)
                && function.GetString() != "HasKeyword")
            {
                yield return (SetAt(Json("\"HasKeyword\""), Member(column.Name), At(0), Member("Data"), Member("Function")), $"{column.Name}[0].Data.");
            }
        }
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
