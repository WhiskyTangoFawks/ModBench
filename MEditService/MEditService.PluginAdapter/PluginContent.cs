namespace MEditService.PluginAdapter;

/// <summary>What reading a plugin file's header tells of it: its flags, masters and description, and the strings files a
/// localized plugin looked for and did not find. Equal when every fact is, its lists by their items.</summary>
public sealed record PluginContent(
    bool IsLight, bool IsMaster, bool IsBlueprint, IReadOnlyList<string> Masters, bool IsMedium, bool IsLocalized,
    IReadOnlyList<string>? MissingStringsFiles = null, string? Description = null)
{
    public bool Equals(PluginContent? other) =>
        other is not null
        && (IsLight, IsMaster, IsBlueprint, IsMedium, IsLocalized, Description) == (other.IsLight, other.IsMaster, other.IsBlueprint, other.IsMedium, other.IsLocalized, other.Description)
        && Masters.SequenceEqual(other.Masters)
        && (MissingStringsFiles ?? []).SequenceEqual(other.MissingStringsFiles ?? []);

    public override int GetHashCode() => HashCode.Combine(IsLight, IsMaster, IsBlueprint, IsMedium, IsLocalized, Description, Masters.Count);
}
