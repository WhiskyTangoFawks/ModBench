namespace MEditService.LoadOrder;

/// <summary>What provides a plugin file (ADR-0012): a mod and its folder, the game, or no mod.</summary>
public abstract record PluginProvider
{
    private PluginProvider()
    {
    }

    public static readonly PluginProvider Game = new GameProvider();

    public static readonly PluginProvider NoMod = new NoModProvider();

    public sealed record FromMod(string Name, string Folder) : PluginProvider;

    private sealed record GameProvider : PluginProvider;

    private sealed record NoModProvider : PluginProvider;
}
