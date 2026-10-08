namespace MEditService.PluginAdapter;

/// <summary>What reading the file told the Index about a plugin, which no registration carries.
/// Read once when the plugin is opened; a plugin that never opened has none.</summary>
public sealed record PluginContent(bool IsLight, bool IsMaster, bool IsBlueprint, IReadOnlyList<string> Masters, int RecordCount, bool IsMedium);
