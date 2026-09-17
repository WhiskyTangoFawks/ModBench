using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Commands;
using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.SourceRepo;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Xunit.Abstractions;
using static MEditService.Tests.TestSupport.Envelopes;

namespace MEditService.Tests.RealData;

/// <summary>Whole-document equality per gesture over a stride sample of the real plugin's records,
/// through the real <see cref="EditRecordHandler"/> over a real tracked tree.</summary>
public sealed class DocumentEditRealDataTests : IDisposable
{
    private static readonly IReadOnlyDictionary<string, RecordTableSchema> Schemas =
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);

    private readonly ITestOutputHelper _output;
    private readonly string _modFolder = Directory.CreateTempSubdirectory("medit-docedit-real-").FullName;
    private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-docedit-real-game-").FullName;
    private readonly SourceRepository _repository;
    private readonly PluginCopyKey _plugin;
    private readonly EditRecordHandler _editHandler;

    public DocumentEditRealDataTests(ITestOutputHelper output)
    {
        _output = output;
        var pluginPath = Path.Combine(_modFolder, CutDownPluginFixture.PluginFileName);
        File.Copy(CutDownPluginFixture.PluginPath, pluginPath);
        _plugin = new PluginCopyKey(CutDownPluginFixture.PluginFileName, "DocEditRealMod");

        var loadOrder = new LoadOrderSnapshot(_gameDirectory, instanceRoot: null, GameRelease.Fallout4,
            SnapshotCopies.Of([new LoadOrderEntry(CutDownPluginFixture.PluginFileName, pluginPath, _plugin.Origin, Slot: 0, Enabled: true, Winning: true)]));
        new TrackService(NullLogger<TrackService>.Instance, TestAdapters.Mutagen())
            .TrackAsync(loadOrder, _plugin.Origin, SourcePreset.Edits)
            .GetAwaiter().GetResult();

        _repository = SourceRepository.Open(_modFolder, GameRelease.Fallout4)
            ?? throw new InvalidOperationException($"Expected '{_modFolder}' to already be tracked.");
        var holder = new LoadOrderHolder();
        holder.Apply(loadOrder);
        _editHandler = TestEditService.EditHandler(holder);
    }

    public void Dispose()
    {
        try { Directory.Delete(_modFolder, recursive: true); } catch (IOException) { }
        try { Directory.Delete(_gameDirectory, recursive: true); } catch (IOException) { }
    }

    // A tracked tree rescans itself whole on every write (ADR-0003), so every Nth record — not
    // every one of 3900+ — keeps a real handler pass a minute rather than an hour.
    private const int Stride = 12;

    [Fact]
    public void EveryStrideRecord_SetOfOneMember_ChangesExactlyThatPath() => RunSweep(Stride, minIdentities: 300, minGestures: 150);

    // The whole corpus, opt-in: MEDIT_SMOKE=1 keeps the every-Nth sample above as the default gate
    // and this as the pass a release checks before it ships.
    [SmokeFact("sweep every record of the cut-down plugin, not a stride sample")]
    public void EveryRecord_SetOfOneMember_ChangesExactlyThatPath() => RunSweep(stride: 1, minIdentities: 3900, minGestures: 1000);

    private void RunSweep(int stride, int minIdentities, int minGestures)
    {
        var modPath = new ModPath(ModKey.FromFileName(CutDownPluginFixture.PluginFileName), CutDownPluginFixture.PluginPath);
        var strings = PluginStrings.In(Path.GetDirectoryName(CutDownPluginFixture.PluginPath)
            ?? throw new InvalidOperationException("Expected the cut-down plugin's path to sit in a directory."));
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        // land/navm/navi publish no schema, so this walk excludes them the same way the Index does.
        var identities = TestAdapters.Mutagen()
            .RecordDocumentsOf(modPath, GameRelease.Fallout4, strings, codec, Schemas)
            .Select(d => d.Identity)
            .Where(i => Schemas.ContainsKey(i.RecordType))
            .Where((_, index) => index % stride == 0)
            .ToList();
        Assert.True(identities.Count > minIdentities, $"Expected a substantial sample of the cut-down plugin; got {identities.Count} documents.");

        var failures = new List<string>();
        var gestures = 0;
        var settledIntoKeyOrder = 0;
        foreach (var identity in identities)
        {
            var schema = Schemas[identity.RecordType];
            var before = _repository.Get(_plugin, identity)?.Body
                ?? throw new InvalidOperationException($"Expected the tracked tree to hold a document for {identity.FormKey}.");
            if (!schema.IsHeader)
            {
                var (settleResult, settled) = Apply(identity, SetAt(Json(JsonSerializer.Serialize(identity.EditorId)), Member("EditorID")));
                if (!settleResult.Applied) { failures.Add($"{identity.RecordType} {identity.FormKey}: settling refused, {settleResult.Refusal} {settleResult.Message}"); continue; }
                if (settled != before) settledIntoKeyOrder++;
                before = settled ?? throw new InvalidOperationException("Expected a successful settle to report the settled body.");
                Reset(identity, before);
            }
            var (envelope, path) = schema.IsHeader
                ? (SetAt(Json("true"), Member("IsSmallMaster")), "ModHeader.Flags")
                : (SetAt(Json("\"MEditProbe\""), Member("EditorID")), "EditorID");

            var (result, after) = Apply(identity, envelope);
            if (!result.Applied) { failures.Add($"{identity.RecordType} {identity.FormKey}: {result.Refusal} {result.Message}"); continue; }
            failures.AddRange(Strays(identity, before, RequireAfter(after, identity), path));
            Reset(identity, before);

            if (schema.IsHeader) continue;
            var root = JsonDocument.Parse(before).RootElement;
            foreach (var (gesture, edited) in Gestures(schema, root))
            {
                gestures++;
                var (gestureResult, landed) = Apply(identity, gesture);
                if (!gestureResult.Applied) { failures.Add($"{identity.RecordType} {identity.FormKey} {gesture.Op} {edited}: {gestureResult.Refusal} {gestureResult.Message}"); continue; }
                failures.AddRange(Strays(identity, before, RequireAfter(landed, identity), edited));
                Reset(identity, before);
            }
        }

        _output.WriteLine($"{identities.Count} records set, {gestures} further gestures, {settledIntoKeyOrder} were first put in key order.");
        Assert.True(gestures > minGestures, $"the sample should offer plenty of array and union gestures; it offered {gestures}");
        Assert.True(failures.Count == 0, $"{failures.Count} gestures did not land as exactly their path:\n{string.Join("\n", failures.Take(20))}");
    }

    private static string RequireAfter(string? after, RecordIdentity identity) =>
        after ?? throw new InvalidOperationException($"Expected an applied edit on {identity.FormKey} to read back a document.");

    private (RecordEditResult Result, string? After) Apply(RecordIdentity identity, RecordEditEnvelope envelope)
    {
        var result = _editHandler.Edit(_plugin, identity.FormKey, envelope);
        var after = result.Applied ? _repository.Get(_plugin, identity)?.Body : null;
        return (result, after);
    }

    // Every case reads and writes independently against the same starting text, never chained.
    private void Reset(RecordIdentity identity, string body) =>
        _repository.Put(_plugin, new SourceDocument(identity.FormKey, identity.RecordType, identity.EditorId, body));

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

    private static IEnumerable<string> Strays(RecordIdentity identity, string before, string after, string path)
    {
        var diffs = JsonDocumentDiff.Of(before, after);
        if (diffs.Count == 0) yield return $"{identity.RecordType} {identity.FormKey}: nothing changed at {path}";
        foreach (var stray in diffs.Where(d => !d.StartsWith(path, StringComparison.Ordinal)))
            yield return $"{identity.RecordType} {identity.FormKey}: {stray}";
    }

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;
}
