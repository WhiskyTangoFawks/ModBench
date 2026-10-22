using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Tests.TestSupport;

/// <summary>Reads a source tree as the real adapter does, and once armed invalidates the
/// index file's database as the tree's ingest begins.</summary>
internal sealed class AbortingTreeSource(string instanceRoot) : DelegatingSourceAdapter(TestAdapters.Source())
{
    private int _armed;

    public void Arm() => Volatile.Write(ref _armed, 1);

    public override ISourceRepositoryReads? Over(RegisteredPlugin plugin, GameRelease release)
    {
        if (Interlocked.Exchange(ref _armed, 0) == 1) IndexFiles.Invalidate(instanceRoot);
        return base.Over(plugin, release);
    }
}
