using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Tests.TestSupport;

/// <summary>Reads source trees as the real adapter does, and counts git status asks and record locates.</summary>
internal sealed class CountingTreeSource(ISourceAdapter inner) : DelegatingSourceAdapter(inner)
{
    private int _asked;
    private int _locates;

    public int LocatesAsked => Volatile.Read(ref _locates);

    public int GitStatusAsked => Volatile.Read(ref _asked);

    private Action? _beforeNextGitStatus;

    public Action? BeforeNextGitStatus
    {
        set => Volatile.Write(ref _beforeNextGitStatus, value);
    }

    public override ISourceRepositoryReads? TreeOf(RegisteredPlugin plugin, GameRelease release) =>
        base.TreeOf(plugin, release) is { } reads ? new Counted(reads, this) : null;

    public override ISourceRepositoryReads? Over(RegisteredPlugin plugin, GameRelease release) =>
        base.Over(plugin, release) is { } reads ? new Counted(reads, this) : null;

    private int _wholeReads;
    private int _namedGitStatus;
    private int _namedReads;
    private int _namedReadThrows;

    /// <summary>The next read of named files throws.</summary>
    public void FailNextNamedRead() => Volatile.Write(ref _namedReadThrows, 1);

    /// <summary>Each read of named files that read them alone.</summary>
    public int NamedReads => Volatile.Read(ref _namedReads);

    /// <summary>Each git status asked of named files alone.</summary>
    public int NamedGitStatusAsked => Volatile.Read(ref _namedGitStatus);

    /// <summary>Each read of a whole tree: a listing of its files, or a read of every document.</summary>
    public int WholeTreeReads => Volatile.Read(ref _wholeReads);

    private sealed class Counted(ISourceRepositoryReads reads, CountingTreeSource owner) : ISourceRepositoryReads
    {
        public RecordStamps StampsOf(PluginAddress plugin)
        {
            Interlocked.Increment(ref owner._wholeReads);
            return reads.StampsOf(plugin);
        }

        public FilesStamp RepositoryStamp() => reads.RepositoryStamp();

        public Answer<T, SourceFailure> ReadDocuments<T>(PluginAddress plugin, Func<IPluginDocuments, T> read)
        {
            Interlocked.Increment(ref owner._wholeReads);
            return reads.ReadDocuments(plugin, read);
        }

        public Answer<FilesRead?, SourceFailure> ReadFiles(PluginAddress plugin, IReadOnlyList<string> files)
        {
            if (Interlocked.Exchange(ref owner._namedReadThrows, 0) == 1) throw new IOException("The named read was made to fail.");
            var read = reads.ReadFiles(plugin, files);
            if (read.Holds(out var alone, out _) && alone is not null) Interlocked.Increment(ref owner._namedReads);
            return read;
        }

        public Answer<IReadOnlyDictionary<string, RecordChange>, SourceFailure> ChangedSinceLastCommitIn(PluginAddress plugin, IReadOnlyList<string> files)
        {
            Interlocked.Increment(ref owner._namedGitStatus);
            return reads.ChangedSinceLastCommitIn(plugin, files);
        }

        public Answer<IReadOnlyDictionary<string, RecordChange>, SourceFailure> ChangedSinceLastCommit(PluginAddress plugin)
        {
            Interlocked.Increment(ref owner._asked);
            Interlocked.Exchange(ref owner._beforeNextGitStatus, null)?.Invoke();
            return reads.ChangedSinceLastCommit(plugin);
        }

        public Answer<IReadOnlyList<string>, SourceFailure> WorkingTreeChangesOf(PluginAddress plugin) => reads.WorkingTreeChangesOf(plugin);

        public Answer<SourceDocument?, SourceFailure> RecordOf(PluginAddress plugin, RecordIdentity identity) => reads.RecordOf(plugin, identity);

        public SourceFailure? WhyUnreadable(PluginAddress plugin, RecordIdentity identity, string body) => reads.WhyUnreadable(plugin, identity, body);

        public Answer<SourceDocument?, SourceFailure> RecordFromText(PluginAddress plugin, string formKey, string text) => reads.RecordFromText(plugin, formKey, text);

        public Answer<DocumentFile?, SourceFailure> DocumentOf(PluginAddress plugin, RecordIdentity identity)
        {
            Interlocked.Increment(ref owner._locates);
            return reads.DocumentOf(plugin, identity);
        }

        public Answer<string?, SourceFailure> RelativePathOf(PluginAddress plugin, RecordIdentity identity)
        {
            Interlocked.Increment(ref owner._locates);
            return reads.RelativePathOf(plugin, identity);
        }

        public Answer<string?, SourceFailure> FileNameOf(PluginAddress plugin, RecordIdentity identity) => reads.FileNameOf(plugin, identity);
    }
}
