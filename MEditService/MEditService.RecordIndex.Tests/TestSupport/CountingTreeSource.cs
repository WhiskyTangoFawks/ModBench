using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Tests.TestSupport;

/// <summary>Reads source trees as the real adapter does, and counts each time git is asked what a tree changed since its last commit.</summary>
internal sealed class CountingTreeSource(ISourceAdapter inner) : DelegatingSourceAdapter(inner)
{
    private int _asked;

    public int GitStatusAsked => Volatile.Read(ref _asked);

    public override ISourceRepositoryReads? TreeOf(RegisteredPlugin plugin, GameRelease release) =>
        base.TreeOf(plugin, release) is { } reads ? new Counted(reads, this) : null;

    public override ISourceRepositoryReads? Over(RegisteredPlugin plugin, GameRelease release) =>
        base.Over(plugin, release) is { } reads ? new Counted(reads, this) : null;

    private sealed class Counted(ISourceRepositoryReads reads, CountingTreeSource owner) : ISourceRepositoryReads
    {
        public RecordStamps StampsOf(PluginAddress plugin) => reads.StampsOf(plugin);

        public FilesStamp RepositoryStamp() => reads.RepositoryStamp();

        public Answer<T, SourceFailure> ReadDocuments<T>(PluginAddress plugin, Func<IPluginDocuments, T> read) => reads.ReadDocuments(plugin, read);

        public Answer<IReadOnlyDictionary<string, RecordChange>, SourceFailure> ChangedSinceLastCommit(PluginAddress plugin)
        {
            Interlocked.Increment(ref owner._asked);
            return reads.ChangedSinceLastCommit(plugin);
        }

        public Answer<IReadOnlyList<string>, SourceFailure> WorkingTreeChangesOf(PluginAddress plugin) => reads.WorkingTreeChangesOf(plugin);

        public Answer<SourceDocument?, SourceFailure> RecordOf(PluginAddress plugin, RecordIdentity identity) => reads.RecordOf(plugin, identity);

        public SourceFailure? WhyUnreadable(PluginAddress plugin, RecordIdentity identity, string body) => reads.WhyUnreadable(plugin, identity, body);

        public Answer<SourceDocument?, SourceFailure> RecordFromText(PluginAddress plugin, string formKey, string text) => reads.RecordFromText(plugin, formKey, text);

        public Answer<DocumentFile?, SourceFailure> DocumentOf(PluginAddress plugin, RecordIdentity identity) => reads.DocumentOf(plugin, identity);

        public Answer<string?, SourceFailure> RelativePathOf(PluginAddress plugin, RecordIdentity identity) => reads.RelativePathOf(plugin, identity);

        public Answer<string?, SourceFailure> FileNameOf(PluginAddress plugin, RecordIdentity identity) => reads.FileNameOf(plugin, identity);
    }
}
