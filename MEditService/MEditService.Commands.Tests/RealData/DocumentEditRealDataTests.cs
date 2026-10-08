using System.Collections.Concurrent;
using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Xunit.Abstractions;
using static MEditService.Commands.Tests.TestSupport.Envelopes;

namespace MEditService.Commands.Tests.RealData;

public sealed class DocumentEditRealDataTests : IDisposable
{
    private static readonly IReadOnlyDictionary<string, RecordTableSchema> Schemas =
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);

    private readonly ITestOutputHelper _output;
    private readonly ScratchDirectory _modFolder = new("medit-docedit-real-");
    private readonly ScratchDirectory _gameDirectory = new("medit-docedit-real-game-");
    private readonly PluginAddress _plugin;
    private readonly TestEditor _editHandler;

    public DocumentEditRealDataTests(ITestOutputHelper output)
    {
        _output = output;
        CutDownPluginFixture.TrackedInto(_modFolder);
        _plugin = new PluginAddress(CutDownPluginFixture.PluginFileName, "DocEditRealMod");

        var loadOrder = SnapshotPlugins.Snapshot(_gameDirectory, instanceRoot: null, GameRelease.Fallout4,
            [new LoadOrderEntry(CutDownPluginFixture.PluginFileName, Path.Combine(_modFolder, CutDownPluginFixture.PluginFileName), _plugin.Origin, Slot: 0, Enabled: true, Winning: true)]);
        var holder = new LoadOrderHolder();
        holder.Apply(loadOrder);
        _editHandler = TestEditService.EditHandler(holder);
    }

    public void Dispose()
    {
        _modFolder.Dispose();
        _gameDirectory.Dispose();
    }

    public static TheoryData<string> RecordTypesOfferingGestures()
    {
        var recordTypes = new TheoryData<string>();
        foreach (var recordType in EveryGesture.Value.Select(g => g.Record.RecordType).Distinct().Order(StringComparer.Ordinal))
            recordTypes.Add(recordType);
        return recordTypes;
    }

    [Fact]
    public void TheSmallestRecordOfEachShape_OffersOverAHundredGestures() =>
        Assert.True(OnTheSmallestRecordOfEachShape().Count() > 100,
            $"the plugin should offer plenty of gestures; it offered {OnTheSmallestRecordOfEachShape().Count()}");

    [Theory]
    [MemberData(nameof(RecordTypesOfferingGestures))]
    public void EveryGestureARecordTypeOffers_OnItsSmallestRecord_ChangesExactlyItsPath(string recordType) =>
        RunSweep([.. OnTheSmallestRecordOfEachShape().Where(g => g.Record.RecordType == recordType)]);

    [SmokeFact("sweep every record of the cut-down plugin, not one per gesture shape")]
    public void EveryGestureOfEveryRecord_ChangesExactlyItsPath()
    {
        Assert.True(EveryGesture.Value.Count > 4900, $"the plugin should offer plenty of gestures; it offered {EveryGesture.Value.Count}");
        RunSweep(EveryGesture.Value);
    }

    private static IEnumerable<Gesture> OnTheSmallestRecordOfEachShape() => EveryGesture.Value
        .OrderBy(g => g.Record.Text.Length)
        .DistinctBy(g => (g.Record.RecordType, g.Envelope.Op, g.Path));

    private readonly record struct Gesture(PluginDocument Record, RecordEditEnvelope Envelope, string Path);

    private static readonly Lazy<IReadOnlyList<Gesture>> EveryGesture = new(() =>
    {
        var modPath = new ModPath(ModKey.FromFileName(CutDownPluginFixture.PluginFileName), CutDownPluginFixture.PluginPath);
        var strings = new PluginStrings(null, Path.GetDirectoryName(CutDownPluginFixture.PluginPath)
            ?? throw new InvalidOperationException("Expected the cut-down plugin's path to sit in a directory."));
        using var documents = TestAdapters.Mutagen().OpenDocuments(modPath, GameRelease.Fallout4, Schemas, strings);
        return [.. documents.Records.Prepend(documents.Header).SelectMany(GesturesOn)];
    });

    private static IEnumerable<Gesture> GesturesOn(PluginDocument record)
    {
        var schema = Schemas[record.RecordType];
        if (schema.IsHeader)
        {
            yield return new(record, SetAt(Json("true"), Member("IsSmallMaster")), "ModHeader.Flags");
            yield break;
        }
        yield return new(record, SetAt(Json("\"MEditProbe\""), Member("EditorID")), "EditorID");
        foreach (var (envelope, path) in EveryGestureWithThePathItMayChange(schema, JsonDocument.Parse(record.Text).RootElement))
            yield return new(record, envelope, path);
    }

    private void RunSweep(IReadOnlyList<Gesture> gestures)
    {

        var trackedTree = TrackedTree();
        var befores = gestures.Select(g => g.Record.FormKey).Distinct().ToDictionary(formKey => formKey, formKey =>
        {
            var document = trackedTree.Get(_plugin, formKey, Schemas)
                ?? throw new InvalidOperationException($"Expected the tracked tree to hold a document for {formKey}.");
            return (document.Identity, document.Body);
        });

        var failures = new List<string>();
        foreach (var gesture in gestures)
        {
            var (identity, before) = befores[gesture.Record.FormKey];
            var named = $"{identity.RecordType} {identity.FormKey} {gesture.Envelope.Op} {gesture.Path}";
            var result = _editHandler.Edit(_plugin, identity.FormKey, gesture.Envelope);
            if (!result.Applied) { failures.Add($"{named}: {result.Refusal} {result.Message}"); continue; }
            var treeAsTheEditLeftIt = TrackedTree();
            var after = treeAsTheEditLeftIt.Get(_plugin, identity)?.Body
                ?? throw new InvalidOperationException($"Expected an applied edit on {identity.FormKey} to read back a document.");
            failures.AddRange(Strays(named, before, after, gesture.Path));
            treeAsTheEditLeftIt.Put(_plugin, new SourceDocument(identity.FormKey, identity.RecordType, identity.EditorId, before));
        }

        _output.WriteLine($"{gestures.Count} gestures on {befores.Count} records.");
        Assert.True(failures.Count == 0, $"{failures.Count} gestures did not land as exactly their path:\n{string.Join("\n", failures.Take(20))}");
    }

    private SourceRepository TrackedTree() => SourceRepository.Open(TestMod.In(_modFolder), GameRelease.Fallout4)
        ?? throw new InvalidOperationException($"Expected '{_modFolder}' to already be tracked.");

    private static IEnumerable<(RecordEditEnvelope Gesture, string Path)> EveryGestureWithThePathItMayChange(RecordTableSchema schema, JsonElement root)
    {
        foreach (var (column, columnMeta) in GesturableColumns.GetOrAdd(schema.TableName, _ => GesturableColumnsOf(schema)))
        {
            if (DocumentNodes.At(root, column.PropertyName) is not { ValueKind: JsonValueKind.Array } array || array.GetArrayLength() == 0) continue;
            var meta = DocumentNodes.VariantFor(columnMeta, root);
            var first = array[0];
            yield return (RemoveAt(Member(column.Name), At(0)), column.Name);
            yield return (AddAt(Member(column.Name)), column.Name);
            var takesMove = meta.KeyMembers == null;
            var aMoveChangesSomething = array.GetArrayLength() > 1 && first.GetRawText() != array[1].GetRawText();
            if (takesMove && aMoveChangesSomething)
                yield return (MoveTo(1, Member(column.Name), At(0)), column.Name);

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

    private static readonly ConcurrentDictionary<string, (ColumnSpec Column, FieldMetadata Meta)[]> GesturableColumns = new();

    private static (ColumnSpec Column, FieldMetadata Meta)[] GesturableColumnsOf(RecordTableSchema schema) =>
        [.. schema.RecordColumns
            .Where(c => c.Synthetic == null)
            .Select(c => (c, c.ToFieldMetadata()))
            .Where(column => column.Item2.IsArray && column.Item2.ReadOnlyReason == null)];

    private static IEnumerable<string> Strays(string gesture, string before, string after, string path)
    {
        var diffs = ConditionEditTests.DocumentDiff(before, after);
        if (diffs.Count == 0) yield return $"{gesture}: nothing changed";
        foreach (var stray in diffs.Where(d => !d.StartsWith(path, StringComparison.Ordinal)))
            yield return $"{gesture}: {stray}";
    }

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;
}
