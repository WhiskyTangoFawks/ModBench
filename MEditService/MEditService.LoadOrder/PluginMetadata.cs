namespace MEditService.LoadOrder;

// One plugin file the Index holds (ADR-0013). Origin (ADR-0012) is opaque here, never
// interpreted; record tables key on (form_key, origin, plugin), and every construction site must
// say which origin this is rather than fall back silently.

// LoadOrderIndex is the plugin's place among the active plugins, null when the snapshot does not
// list it as active.
public record PluginMetadata(
    string Name,
    string Path,
    int? LoadOrderIndex,
    bool IsLight,
    bool IsMaster,
    bool IsBlueprint,
    IReadOnlyList<string> Masters,
    int RecordCount,
    string Origin)
{
    public PluginAddress Key => new(Name, Origin);

    public Registration Registration => new(LoadOrderIndex);

    public PluginContent Content => new(IsLight, IsMaster, IsBlueprint, Masters, RecordCount);
}

/// <summary>What reading the file told the Index about a plugin, which no registration carries.
/// Read once when the plugin is opened; a plugin that never opened has none.</summary>
public sealed record PluginContent(bool IsLight, bool IsMaster, bool IsBlueprint, IReadOnlyList<string> Masters, int RecordCount);
