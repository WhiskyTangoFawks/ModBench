namespace MEditService.LoadOrder;

/// <summary>What provides a plugin file (ADR-0012): a mod and its folder, the game, or no mod.</summary>
public abstract record PluginProvider
{
    public static readonly PluginProvider Game = new GameProvider();

    public static readonly PluginProvider NoMod = new NoModProvider();

    public sealed record FromMod(string Name, string Folder) : PluginProvider;

    private sealed record GameProvider : PluginProvider;

    private sealed record NoModProvider : PluginProvider;

    internal static PluginProvider Of(string origin, string pluginPath)
    {
        if (PluginOrigin.IsDataDirectory(origin)) return Game;
        if (PluginOrigin.IsOverwrite(origin)) return NoMod;
        var folder = Path.GetDirectoryName(pluginPath)
            ?? throw new ArgumentException($"'{pluginPath}' is a root, and no root is a mod folder.", nameof(pluginPath));
        return new FromMod(origin, folder);
    }
}
