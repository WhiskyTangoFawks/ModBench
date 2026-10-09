using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.RepositoriesLib;

namespace MEditService.SourceAdapter;

/// <summary>The reads the record index makes of one mod folder's source.</summary>
public interface ISourceRepositoryReads
{
    RecordStamps StampsOf(PluginAddress plugin);

    Answer<T, SourceFailure> ReadDocuments<T>(PluginAddress plugin, Func<IPluginDocuments, T> read);

    Answer<IReadOnlyDictionary<string, RecordChange>, SourceFailure> ChangedSinceLastCommit(PluginAddress plugin);

    Answer<SourceDocument?, SourceFailure> RecordOf(PluginAddress plugin, RecordIdentity identity);

    SourceFailure? WhyUnreadable(PluginAddress plugin, RecordIdentity identity, string body);

    Answer<SourceDocument?, SourceFailure> RecordFromText(PluginAddress plugin, string formKey, string text);

    Answer<DocumentFile?, SourceFailure> DocumentOf(PluginAddress plugin, RecordIdentity identity);

    Answer<string?, SourceFailure> RelativePathOf(PluginAddress plugin, RecordIdentity identity);

    Answer<string?, SourceFailure> FileNameOf(PluginAddress plugin, RecordIdentity identity);
}
