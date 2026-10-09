using MEditService.PluginAdapter;

namespace MEditService.TestSupport;

/// <summary>The production Plugin adapter, for a test with no composition root to resolve it
/// from. Built per call: a shared instance would be a second door beside the host's registration.</summary>
public static class TestAdapters
{
    public static IPluginAdapter Mutagen() => new MutagenPluginAdapter(TimeProvider.System);
}
