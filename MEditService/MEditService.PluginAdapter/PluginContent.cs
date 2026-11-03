namespace MEditService.PluginAdapter;

/// <summary>What reading a plugin file tells of it: its flags, masters, record count and header description, and the
/// strings files a localized plugin looked for and did not find.</summary>
public sealed record PluginContent(
    bool IsLight, bool IsMaster, bool IsBlueprint, IReadOnlyList<string> Masters, int RecordCount, bool IsMedium, bool IsLocalized,
    IReadOnlyList<string>? MissingStringsFiles = null, string? Description = null);
