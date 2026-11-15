using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.RepositoriesLib;

namespace MEditService.SourceAdapter;

/// <summary>The reads the record index makes of one source folder's source.</summary>
public interface ISourceRepositoryReads
{
    RecordStamps StampsOf(PluginAddress plugin);

    Answer<T, SourceFailure> ReadDocuments<T>(PluginAddress plugin, Func<IPluginDocuments, T> read);

    /// <summary>What <paramref name="files"/>, absolute paths in the plugin's tree, hold now and held when last read; null
    /// when they do not read alone. A written document stands in for its file while it keeps its stamp.</summary>
    Answer<FilesRead?, SourceFailure> ReadFiles(PluginAddress plugin, IReadOnlyList<string> files, IReadOnlyList<WrittenDocument> written);

    /// <summary>What a commit or a checkout moves without touching a document: with the documents' stamps unchanged,
    /// an equal stamp that vouches means <see cref="ChangedSinceLastCommit"/> answers as it did.</summary>
    FilesStamp RepositoryStamp();

    Answer<IReadOnlyDictionary<string, RecordChange>, SourceFailure> ChangedSinceLastCommit(PluginAddress plugin);

    /// <summary>As <see cref="ChangedSinceLastCommit"/>, of the records <paramref name="files"/> hold, absolute paths in the
    /// plugin's tree: a record none of them held at the last commit is added. A written document stands in as in ReadFiles.</summary>
    Answer<IReadOnlyDictionary<string, RecordChange>, SourceFailure> ChangedSinceLastCommitIn(
        PluginAddress plugin, IReadOnlyList<string> files, IReadOnlyList<WrittenDocument> written);

    /// <summary>Each file under the plugin's tree that git status names as changed or untracked, relative to the
    /// source folder; ignored files are not changes.</summary>
    Answer<IReadOnlyList<string>, SourceFailure> WorkingTreeChangesOf(PluginAddress plugin);

    Answer<SourceDocument?, SourceFailure> RecordOf(PluginAddress plugin, RecordIdentity identity);

    SourceFailure? WhyUnreadable(PluginAddress plugin, RecordIdentity identity, string body);

    Answer<SourceDocument?, SourceFailure> RecordFromText(PluginAddress plugin, string formKey, string text);

    Answer<DocumentFile?, SourceFailure> DocumentOf(PluginAddress plugin, RecordIdentity identity);

    Answer<string?, SourceFailure> RelativePathOf(PluginAddress plugin, RecordIdentity identity);

    Answer<string?, SourceFailure> FileNameOf(PluginAddress plugin, RecordIdentity identity);
}

/// <summary>Each record's own document the named files hold, and each FormKey whose document they held and hold not.</summary>
public sealed record FilesRead(IReadOnlyList<PluginDocument> Documents, IReadOnlyList<string> Gone);
