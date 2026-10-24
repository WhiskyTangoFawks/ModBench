using MEditService.PluginAdapter;
using MEditService.SourceAdapter;
using Mutagen.Bethesda;

namespace MEditService.TestSupport;

/// <summary>The production Plugin adapter, for a test with no composition root to resolve it
/// from. Built per call: a shared instance would be a second door beside the host's registration.</summary>
public static class TestAdapters
{
    public static IPluginAdapter Mutagen() => new MutagenPluginAdapter(TimeProvider.System);

    public static ISourceAdapter Source() => Source(TimeProvider.System);

    public static ISourceAdapter Source(TimeProvider time) => new GitSourceAdapter(new UnsavedDocuments(), time);

    public static ISourceRepository OpenSourceMod(string modFolder, GameRelease release) =>
        Source().Open(TestMod.In(modFolder), release)
        ?? throw new InvalidOperationException($"Expected '{modFolder}' to already be a source mod.");
}
