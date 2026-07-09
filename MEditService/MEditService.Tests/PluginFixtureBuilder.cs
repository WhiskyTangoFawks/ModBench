using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Binary.Parameters;

namespace MEditService.Tests;

public sealed class PluginFixtureBuilder(string prefix = "medit")
{
    private readonly string _prefix = prefix;
    private readonly List<(string Name, bool Listed, Action<Fallout4Mod, IReadOnlyList<Fallout4Mod>>? Configure, BinaryWriteParameters? WriteParams)> _plugins = [];

    public PluginFixtureBuilder WithPlugin(string name, Action<Fallout4Mod>? configure = null, bool listed = true, BinaryWriteParameters? writeParams = null)
    {
        _plugins.Add((name, listed, configure is null ? null : (mod, _) => configure(mod), writeParams));
        return this;
    }

    public PluginFixtureBuilder WithPlugin(string name, Action<Fallout4Mod, IReadOnlyList<Fallout4Mod>> configure, bool listed = true)
    {
        _plugins.Add((name, listed, configure, null));
        return this;
    }

    public PluginFixtureData Build()
    {
        var dataFolder = Path.Combine(Path.GetTempPath(), $"{_prefix}-{Guid.NewGuid():N}");
        Directory.CreateDirectory(dataFolder);

        var builtMods = new List<Fallout4Mod>();
        foreach (var (name, _, configure, writeParams) in _plugins)
        {
            var mod = new Fallout4Mod(ModKey.FromFileName(name), Fallout4Release.Fallout4);
            configure?.Invoke(mod, builtMods.AsReadOnly());
            mod.WriteToBinary(Path.Combine(dataFolder, name), writeParams);
            builtMods.Add(mod);
        }

        var pluginsTxtPath = Path.Combine(dataFolder, "Plugins.txt");
        var lines = _plugins
            .Where(p => p.Listed)
            .Select(p => $"*{p.Name}");
        File.WriteAllText(pluginsTxtPath, string.Join("\n", lines) + "\n");

        return new PluginFixtureData(dataFolder, pluginsTxtPath);
    }

    /// <summary>
    /// Builds the plugins into <em>scattered</em> physical locations to mirror an MO2 instance:
    /// implicit masters (e.g. Fallout4.esm) land in a single game directory; every other plugin
    /// gets its own folder. Returns the game directory plus the ordered explicit
    /// <c>{Name, Path}</c> list (non-implicit plugins, in declared order) for <c>LoadExplicit</c>.
    /// </summary>
    public ScatteredFixtureData BuildScattered()
    {
        var implicitNames = Implicits.Get(GameRelease.Fallout4).Listings
            .Select(l => l.FileName.ToString())
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

        var root = Path.Combine(Path.GetTempPath(), $"{_prefix}-scatter-{Guid.NewGuid():N}");
        var gameDir = Path.Combine(root, "GameDir");
        Directory.CreateDirectory(gameDir);

        var builtMods = new List<Fallout4Mod>();
        var explicitPlugins = new List<(string Name, string Path)>();
        var i = 0;
        foreach (var (name, _, configure, writeParams) in _plugins)
        {
            var mod = new Fallout4Mod(ModKey.FromFileName(name), Fallout4Release.Fallout4);
            configure?.Invoke(mod, builtMods.AsReadOnly());

            string targetPath;
            if (implicitNames.Contains(name))
            {
                targetPath = Path.Combine(gameDir, name);
            }
            else
            {
                var folder = Path.Combine(root, $"mod-{i:D2}-{Path.GetFileNameWithoutExtension(name)}");
                Directory.CreateDirectory(folder);
                targetPath = Path.Combine(folder, name);
                explicitPlugins.Add((name, targetPath));
            }

            mod.WriteToBinary(targetPath, writeParams);
            builtMods.Add(mod);
            i++;
        }

        return new ScatteredFixtureData(root, gameDir, explicitPlugins);
    }
}

public sealed record PluginFixtureData(string DataFolder, string PluginsTxtPath) : IDisposable
{
    public void Dispose() => Directory.Delete(DataFolder, recursive: true);
}

public sealed record ScatteredFixtureData(
    string Root, string GameDirectory, IReadOnlyList<(string Name, string Path)> Plugins) : IDisposable
{
    public void Dispose() => Directory.Delete(Root, recursive: true);
}
