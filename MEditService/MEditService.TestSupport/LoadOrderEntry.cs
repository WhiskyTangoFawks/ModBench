using MEditService.LoadOrder;

namespace MEditService.TestSupport;

/// <summary>A fixture's plugin as Mod Management knows it. The fixture stands in for Mod Management,
/// which alone decides the active plugins from these facts (ADR-0013).</summary>
public record LoadOrderEntry(
    string Name, string Path, string Origin, int? Line, bool Enabled, bool Winning, bool LoadedWithNoLine = false,
    PluginProvider? NamedProvider = null, PluginStrings? NamedStrings = null)
{
    /// <summary>Modbench's origin for a plugin in Overwrite, the files outside every mod.</summary>
    public const string OverwriteOrigin = "overwrite/";

    public PluginAddress Key => new(Name, Origin);

    /// <summary>The fixture's one provider rule: a mod's folder, and its source folder, is the plugin's
    /// directory, unless <see cref="NamedProvider"/> says otherwise.</summary>
    public PluginProvider Provider => NamedProvider ?? Origin switch
    {
        _ when Is(PluginOrigin.DataDirectory) => PluginProvider.Game,
        _ when Is(OverwriteOrigin) => PluginProvider.NoMod,
        _ => System.IO.Path.GetDirectoryName(Path) is { } folder
            ? new PluginProvider.FromMod(Origin, folder, folder)
            : throw new InvalidOperationException($"'{Path}' has no folder."),
    };

    /// <summary>The fixture's one strings rule: the strings files beside the plugin as the snapshot is taken, unless
    /// <see cref="NamedStrings"/> says otherwise.</summary>
    public PluginStrings Strings => NamedStrings ?? HandedStrings.Of(Path);

    private bool Is(string reserved) => string.Equals(Origin, reserved, StringComparison.OrdinalIgnoreCase);

    /// <summary>The plugin as the PUT /load-order body carries it.</summary>
    public object Wire => new
    {
        Name,
        Path,
        Origin,
        Provider = ProviderWire.Of(Provider),
        Line,
        LineNamesIt = Winning,
        Strings.Archives,
        Strings.StringsFiles,
    };
}

/// <summary>A provider as the PUT /load-order body spells it.</summary>
internal static class ProviderWire
{
    public static object Of(PluginProvider provider) => provider switch
    {
        PluginProvider.FromMod mod => new { Kind = "Mod", Mod = mod.Name, mod.Folder, mod.SourceFolder },
        _ when provider == PluginProvider.Game => new { Kind = "Game" },
        _ => new { Kind = "None" },
    };
}
