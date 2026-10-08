using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;

namespace MEditService.SourceAdapter;

/// <summary>The reads the record index makes of one mod folder's source, each as
/// <see cref="SourceRepository"/> answers it.</summary>
public interface ISourceRepositoryReads
{
    RecordStamps StampsOf(PluginAddress plugin);

    IPluginDocuments OpenDocuments(PluginAddress plugin, IReadOnlyDictionary<string, RecordTableSchema> schemas);

    IReadOnlyDictionary<string, RecordChange> ChangedSinceLastCommit(
        PluginAddress plugin, IReadOnlyDictionary<string, RecordTableSchema> schemas);

    SourceDocument? RecordOf(PluginAddress plugin, RecordIdentity identity);

    void RefuseUnreadable(
        PluginAddress plugin, RecordIdentity identity, string body, IReadOnlyDictionary<string, RecordTableSchema> schemas);

    SourceDocument? RecordFromText(
        PluginAddress plugin, string formKey, string text, IReadOnlyDictionary<string, RecordTableSchema> schemas);

    DocumentFile? DocumentOf(PluginAddress plugin, RecordIdentity identity);

    string? RelativePathOf(PluginAddress plugin, RecordIdentity identity);

    string? FileNameOf(PluginAddress plugin, RecordIdentity identity);
}
