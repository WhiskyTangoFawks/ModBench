using MEditService.LoadOrder;

namespace MEditService.TestSupport;

/// <summary>A fixture's plugin as Mod Management knows it. The fixture stands in for Mod Management,
/// which alone decides the active plugins from these facts (ADR-0013).</summary>
public record LoadOrderEntry(
    string Name, string Path, string Origin, int? Line, bool Enabled, bool Winning, bool LoadedWithNoLine = false,
    PluginProvider? NamedProvider = null)
{
    public PluginAddress Key => new(Name, Origin);

    /// <summary>The fixture's one provider rule: a mod's folder is the plugin's directory, unless
    /// <see cref="NamedProvider"/> says otherwise.</summary>
    public PluginProvider Provider => NamedProvider ?? Origin switch
    {
        _ when Is(PluginOrigin.DataDirectory) => PluginProvider.Game,
        _ when Is(PluginOrigin.Overwrite) => PluginProvider.NoMod,
        _ => new PluginProvider.FromMod(
            Origin, System.IO.Path.GetDirectoryName(Path) ?? throw new InvalidOperationException($"'{Path}' has no folder.")),
    };

    private bool Is(string reserved) => string.Equals(Origin, reserved, StringComparison.OrdinalIgnoreCase);

    /// <summary>The plugin as the PUT /load-order body carries it.</summary>
    public object Wire => new { Name, Path, Origin, Provider = ProviderWire.Of(Provider), Line, LineNamesIt = Winning };
}

/// <summary>A provider as the PUT /load-order body spells it.</summary>
internal static class ProviderWire
{
    public static object Of(PluginProvider provider) => provider switch
    {
        PluginProvider.FromMod mod => new { Kind = "Mod", Mod = mod.Name, mod.Folder },
        _ when provider == PluginProvider.Game => new { Kind = "Game" },
        _ => new { Kind = "None" },
    };
}
