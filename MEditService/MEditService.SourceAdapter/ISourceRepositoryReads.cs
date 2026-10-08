using MEditService.Codec.Serialization;
using MEditService.LoadOrder;

namespace MEditService.SourceAdapter;

/// <summary>The reads the record index makes of one mod folder's source.</summary>
public interface ISourceRepositoryReads
{
    RecordStamps StampsOf(PluginAddress plugin);

    IPluginDocuments OpenDocuments(PluginAddress plugin);

    IReadOnlyDictionary<string, RecordChange> ChangedSinceLastCommit(
        PluginAddress plugin);

    SourceDocument? RecordOf(PluginAddress plugin, RecordIdentity identity);

    void RefuseUnreadable(
        PluginAddress plugin, RecordIdentity identity, string body);

    SourceDocument? RecordFromText(
        PluginAddress plugin, string formKey, string text);

    DocumentFile? DocumentOf(PluginAddress plugin, RecordIdentity identity);

    string? RelativePathOf(PluginAddress plugin, RecordIdentity identity);

    string? FileNameOf(PluginAddress plugin, RecordIdentity identity);
}
