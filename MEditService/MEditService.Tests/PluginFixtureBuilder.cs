using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests;

public sealed class PluginFixtureBuilder
{
    private readonly string _prefix;
    private readonly List<(string Name, bool Listed, Action<Fallout4Mod, IReadOnlyList<Fallout4Mod>>? Configure)> _plugins = [];

    public PluginFixtureBuilder(string prefix = "medit")
    {
        _prefix = prefix;
    }

    public PluginFixtureBuilder WithPlugin(string name, Action<Fallout4Mod>? configure = null, bool listed = true)
    {
        _plugins.Add((name, listed, configure is null ? null : (mod, _) => configure(mod)));
        return this;
    }

    public PluginFixtureBuilder WithPlugin(string name, Action<Fallout4Mod, IReadOnlyList<Fallout4Mod>> configure, bool listed = true)
    {
        _plugins.Add((name, listed, configure));
        return this;
    }

    public PluginFixtureData Build()
    {
        var dataFolder = Path.Combine(Path.GetTempPath(), $"{_prefix}-{Guid.NewGuid():N}");
        Directory.CreateDirectory(dataFolder);

        var builtMods = new List<Fallout4Mod>();
        foreach (var (name, _, configure) in _plugins)
        {
            var mod = new Fallout4Mod(ModKey.FromFileName(name), Fallout4Release.Fallout4);
            configure?.Invoke(mod, builtMods.AsReadOnly());
            mod.WriteToBinary(Path.Combine(dataFolder, name));
            builtMods.Add(mod);
        }

        var pluginsTxtPath = Path.Combine(dataFolder, "Plugins.txt");
        var lines = _plugins
            .Where(p => p.Listed)
            .Select(p => $"*{p.Name}");
        File.WriteAllText(pluginsTxtPath, string.Join("\n", lines) + "\n");

        return new PluginFixtureData(dataFolder, pluginsTxtPath);
    }
}

public sealed record PluginFixtureData(string DataFolder, string PluginsTxtPath) : IDisposable
{
    public void Dispose() => Directory.Delete(DataFolder, recursive: true);
}
