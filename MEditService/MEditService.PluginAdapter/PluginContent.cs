namespace MEditService.PluginAdapter;

/// <summary>What reading a plugin file tells of it: its flags, masters and record count.</summary>
public sealed record PluginContent(bool IsLight, bool IsMaster, bool IsBlueprint, IReadOnlyList<string> Masters, int RecordCount, bool IsMedium);
