using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>A real tracked plugin with no records of its own: a case seeds the document it needs,
/// then edits it through the real <see cref="EditRecordChangesHandler"/>, saving what it answers.</summary>
internal sealed class DocumentEditFixture : TestInstance
{
    private const string PluginName = "DocEdit.esp";

    private ISourceRepository Repository => RepositoryOf(Plugin)
        ?? throw new InvalidOperationException($"Expected '{Plugin}' to already be tracked.");

    internal PluginAddress Plugin { get; }

    internal DocumentEditFixture() =>
        Plugin = Add(new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4), "DocEditMod");

    /// <summary>Seeds the working tree with a real record's own codec-serialized document; returns
    /// its FormKey.</summary>
    internal string Seed(IMajorRecordGetter record, string recordType)
    {
        var text = RecordTextCodec.SerializeToText(record, GameRelease.Fallout4);
        SeedRaw(record.FormKey.ToString(), recordType, record.EditorID, text);
        return record.FormKey.ToString();
    }

    /// <summary>Seeds an exact document body, for a case whose input is a shape the codec itself
    /// would not produce.</summary>
    internal void SeedRaw(string formKey, string recordType, string? editorId, string body) =>
        Repository.Put(Plugin, new SourceDocument(formKey, recordType, editorId, body)).Wrote();

    internal string Document(string formKey) =>
        TrackedTree.Document(ModFolderOf(Plugin), Plugin, formKey)?.Body
            ?? throw new InvalidOperationException($"Expected a document for '{formKey}'.");

    /// <summary>Applies <paramref name="envelope"/> through the real handler; on success returns the
    /// document as it now reads, otherwise null (and the document is untouched).</summary>
    internal (RecordEditResult Result, string? After) Apply(string formKey, RecordEditEnvelope envelope)
    {
        var result = EditHandler.Edit(Plugin, formKey, envelope);
        return (result, result.Applied ? Document(formKey) : null);
    }
}
