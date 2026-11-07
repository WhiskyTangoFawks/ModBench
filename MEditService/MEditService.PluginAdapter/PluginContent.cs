namespace MEditService.PluginAdapter;

/// <summary>What reading a plugin file's header tells of it: its flags, masters and description, and the strings files a
/// localized plugin looked for and did not find.</summary>
public sealed record PluginContent(
    bool IsLight, bool IsMaster, bool IsBlueprint, IReadOnlyList<string> Masters, bool IsMedium, bool IsLocalized,
    IReadOnlyList<string>? MissingStringsFiles = null, string? Description = null);
