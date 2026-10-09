using MEditService.Codec.Serialization;
using MEditService.LoadOrder;

namespace MEditService.SourceAdapter;

/// <summary>The reads the record index makes of one mod folder's source.</summary>
public interface ISourceRepositoryReads
{
    RecordStamps StampsOf(PluginAddress plugin);

    SourceAnswer<T> ReadDocuments<T>(PluginAddress plugin, Func<IPluginDocuments, T> read);

    SourceAnswer<IReadOnlyDictionary<string, RecordChange>> ChangedSinceLastCommit(PluginAddress plugin);

    SourceAnswer<SourceDocument?> RecordOf(PluginAddress plugin, RecordIdentity identity);

    SourceFailure? WhyUnreadable(PluginAddress plugin, RecordIdentity identity, string body);

    SourceAnswer<SourceDocument?> RecordFromText(PluginAddress plugin, string formKey, string text);

    SourceAnswer<DocumentFile?> DocumentOf(PluginAddress plugin, RecordIdentity identity);

    SourceAnswer<string?> RelativePathOf(PluginAddress plugin, RecordIdentity identity);

    SourceAnswer<string?> FileNameOf(PluginAddress plugin, RecordIdentity identity);
}
