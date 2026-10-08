using MEditService.LoadOrder;
using MEditService.PluginAdapter;

namespace MEditService.Index;

// One plugin file the Index holds (ADR-0012). Origin is opaque here, never interpreted; record
// tables key on it (ADR-0012), and every construction site must say which origin this
// is rather than fall back silently.

// LoadOrderIndex is the plugin's place among the active plugins, null when the snapshot does not
// list it as active.
public record PluginMetadata(
    string Name,
    string Path,
    int? LoadOrderIndex,
    bool IsLight,
    bool IsMedium,
    bool IsMaster,
    bool IsBlueprint,
    IReadOnlyList<string> Masters,
    int RecordCount,
    string Origin,
    PluginProvider Provider)
{
    public PluginAddress Key => new(Name, Origin);

    // What the Index reads of a held plugin is its path and provider, never its line.
    public RegisteredPlugin Registered => new(Name, Origin, Path, Provider, Line: null);

    public Registration Registration => new(LoadOrderIndex);

    public PluginContent Content => new(IsLight, IsMaster, IsBlueprint, Masters, RecordCount, IsMedium);
}
