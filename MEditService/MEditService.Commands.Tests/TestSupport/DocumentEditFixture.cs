using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Commands;
using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>A real tracked plugin with no records of its own: a case seeds the document it needs,
/// then edits it through the real <see cref="EditRecordHandler"/>.</summary>
internal sealed class DocumentEditFixture : IDisposable
{
    private const string PluginName = "DocEdit.esp";
    private static readonly RecordTextCodec Codec = new(NullLogger<RecordTextCodec>.Instance);

    private readonly string _modFolder = Directory.CreateTempSubdirectory("medit-docedit-").FullName;
    private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-docedit-game-").FullName;
    private readonly SourceRepository _repository;

    internal PluginCopyKey Plugin { get; } = new(PluginName, "DocEditMod");
    internal EditRecordHandler EditHandler { get; }

    internal DocumentEditFixture()
    {
        SourceRepository.Track(_modFolder, SourcePreset.Edits, [], new TrackProvenance(null, null, new Dictionary<string, string>()));
        _repository = SourceRepository.Open(_modFolder, GameRelease.Fallout4)
            ?? throw new InvalidOperationException($"Expected '{_modFolder}' to already be tracked.");

        var pluginPath = Path.Combine(_modFolder, PluginName);
        var entries = new[] { new LoadOrderEntry(PluginName, pluginPath, Plugin.Origin, Slot: 0, Enabled: true, Winning: true) };
        var loadOrder = new LoadOrderSnapshot(_gameDirectory, _modFolder, GameRelease.Fallout4, SnapshotCopies.Of(entries));
        var holder = new LoadOrderHolder();
        holder.Apply(loadOrder);
        EditHandler = TestEditService.EditHandler(holder);
    }

    /// <summary>Seeds the working tree with a real record's own codec-serialized document; returns
    /// its FormKey.</summary>
    internal string Seed(IMajorRecordGetter record, string recordType)
    {
        var body = Codec.SerializeToBytes(record, GameRelease.Fallout4);
        SeedRaw(record.FormKey.ToString(), recordType, record.EditorID, System.Text.Encoding.UTF8.GetString(body));
        return record.FormKey.ToString();
    }

    /// <summary>Seeds an exact document body, for a case whose input is a shape the codec itself
    /// would not produce.</summary>
    internal void SeedRaw(string formKey, string recordType, string? editorId, string body) =>
        _repository.Put(Plugin, new SourceDocument(formKey, recordType, editorId, body));

    internal string Document(string formKey) =>
        TrackedTree.Document(_modFolder, Plugin, formKey)?.Body
            ?? throw new InvalidOperationException($"Expected a document for '{formKey}'.");

    /// <summary>Applies <paramref name="envelope"/> through the real handler; on success returns the
    /// document as it now reads, otherwise null (and the document is untouched).</summary>
    internal (RecordEditResult Result, string? After) Apply(string formKey, RecordEditEnvelope envelope)
    {
        var result = EditHandler.Edit(Plugin, formKey, envelope);
        return (result, result.Applied ? Document(formKey) : null);
    }

    public void Dispose()
    {
        try { Directory.Delete(_modFolder, recursive: true); }
        catch (IOException) { /* scratch directory, best effort */ }
        catch (UnauthorizedAccessException) { /* ditto */ }
        try { Directory.Delete(_gameDirectory, recursive: true); }
        catch (IOException) { /* ditto */ }
    }
}
