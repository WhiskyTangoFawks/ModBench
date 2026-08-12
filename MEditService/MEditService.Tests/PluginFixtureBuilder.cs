using MEditService.Core.Session;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Binary.Parameters;

namespace MEditService.Tests;

public sealed class PluginFixtureBuilder(string prefix = "medit")
{
    private readonly string _prefix = prefix;
    private readonly List<(string Name, bool Listed, bool Enabled, Action<Fallout4Mod, IReadOnlyList<Fallout4Mod>>? Configure, BinaryWriteParameters? WriteParams, string Origin)> _plugins = [];

    public PluginFixtureBuilder WithPlugin(string name, Action<Fallout4Mod>? configure = null, bool listed = true, BinaryWriteParameters? writeParams = null, bool enabled = true, string origin = PluginOrigin.DataDirectory)
    {
        _plugins.Add((name, listed, enabled, configure is null ? null : (mod, _) => configure(mod), writeParams, origin));
        return this;
    }

    public PluginFixtureBuilder WithPlugin(string name, Action<Fallout4Mod, IReadOnlyList<Fallout4Mod>> configure, bool listed = true, bool enabled = true, string origin = PluginOrigin.DataDirectory)
    {
        _plugins.Add((name, listed, enabled, configure, null, origin));
        return this;
    }

    public PluginFixtureData Build()
    {
        var dataFolder = Path.Combine(Path.GetTempPath(), $"{_prefix}-{Guid.NewGuid():N}");
        Directory.CreateDirectory(dataFolder);

        var builtMods = new List<Fallout4Mod>();
        foreach (var (name, _, _, configure, writeParams, _) in _plugins)
        {
            var mod = new Fallout4Mod(ModKey.FromFileName(name), Fallout4Release.Fallout4);
            configure?.Invoke(mod, builtMods.AsReadOnly());
            mod.WriteToBinary(Path.Combine(dataFolder, name), writeParams);
            builtMods.Add(mod);
        }

        var pluginsTxtPath = Path.Combine(dataFolder, "Plugins.txt");
        var lines = _plugins
            .Where(p => p.Listed)
            .Select(p => $"{(p.Enabled ? "*" : "")}{p.Name}");
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
        var explicitPlugins = new List<(string Name, string Path, string Origin)>();
        var i = 0;
        foreach (var (name, _, _, configure, writeParams, origin) in _plugins)
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
                explicitPlugins.Add((name, targetPath, origin));
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

/// <summary>
/// Shared shape of a plugin-data fixture loadable through the API test host: a data folder +
/// Plugins.txt built by <see cref="PluginFixtureBuilder"/>, plus a construction hook so generic
/// consumers (<c>LoadedApiFixture&lt;TPlugin&gt;</c>) don't need a bare <c>new()</c> constraint.
/// </summary>
public interface IApiPluginFixture<TSelf> : IDisposable where TSelf : IApiPluginFixture<TSelf>
{
    string DataFolder { get; }
    string PluginsTxtPath { get; }
    static abstract TSelf Create();
}

public sealed record ScatteredFixtureData(
    string Root, string GameDirectory, IReadOnlyList<(string Name, string Path, string Origin)> Plugins) : IDisposable
{
    public void Dispose() => Directory.Delete(Root, recursive: true);
}
