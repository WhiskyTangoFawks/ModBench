using MEditService.Core.Plugins;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Binary.Parameters;

namespace MEditService.Tests;

public sealed class PluginFixtureBuilder(string prefix = "medit")
{
    private readonly string _prefix = prefix;
    private readonly List<(string Name, bool Listed, bool Enabled, Action<Fallout4Mod, IReadOnlyList<Fallout4Mod>>? Configure, BinaryWriteParameters? WriteParams, string Origin)> _plugins = [];
    // A Creation Club catalog entry, not a plugins.txt line, so it is kept separate from _plugins'
    // Listed flag: BuildScattered ignores Listed entirely, having no plugins.txt.
    private readonly List<string> _cccCatalog = [];

    public PluginFixtureBuilder WithPlugin(string name, Action<Fallout4Mod>? configure = null, bool listed = true, BinaryWriteParameters? writeParams = null, bool enabled = true, string origin = PluginOrigin.DataDirectory)
    {
        _plugins.Add((name, listed, enabled, configure is null ? null : (mod, _) => configure(mod), writeParams, origin));
        return this;
    }

    public PluginFixtureBuilder WithPlugin(string name, Action<Fallout4Mod, IReadOnlyList<Fallout4Mod>> configure, bool listed = true, bool enabled = true, string origin = PluginOrigin.DataDirectory, BinaryWriteParameters? writeParams = null)
    {
        _plugins.Add((name, listed, enabled, configure, writeParams, origin));
        return this;
    }

    public PluginFixtureBuilder WithCreationClubCatalog(params string[] names)
    {
        _cccCatalog.AddRange(names);
        return this;
    }

    public PluginFixtureData Build()
    {
        // Fallout4.ccc lives one directory above the Data folder in a real install, so the fixture
        // needs a root above dataFolder.
        var root = Path.Combine(Path.GetTempPath(), $"{_prefix}-{Guid.NewGuid():N}");
        var dataFolder = Path.Combine(root, "Data");
        Directory.CreateDirectory(dataFolder);

        var builtMods = new List<Fallout4Mod>();
        foreach (var (name, _, _, configure, writeParams, _) in _plugins)
        {
            var mod = new Fallout4Mod(ModKey.FromFileName(name), Fallout4Release.Fallout4);
            configure?.Invoke(mod, builtMods.AsReadOnly());
            mod.WriteToBinary(Path.Combine(dataFolder, name), writeParams);
            builtMods.Add(mod);
        }

        // No plugins.txt is written: the ordered snapshot is the load order. `Listed` puts a plugin
        // in it and `Enabled` is the `*` prefix; every copy wins (ADR-0044) unless a test says so.
        var explicitPlugins = _plugins
            .Where(p => p.Listed)
            .Select((p, slot) => new LoadOrderEntry(p.Name, Path.Combine(dataFolder, p.Name), p.Origin, slot, p.Enabled, Winning: true))
            .ToList();

        WriteCreationClubCatalog(root);

        return new PluginFixtureData(dataFolder, explicitPlugins, root);
    }

    public ScatteredFixtureData BuildScattered()
    {
        var implicitNames = Implicits.Get(GameRelease.Fallout4).Listings
            .Select(l => l.FileName.ToString())
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        // A cataloged CC plugin's file lives in the game directory, never a mod folder, the same as
        // an implicit master. A test wanting it explicitly listed too appends that entry by hand.
        var cccNames = _cccCatalog.ToHashSet(StringComparer.OrdinalIgnoreCase);

        var root = Path.Combine(Path.GetTempPath(), $"{_prefix}-scatter-{Guid.NewGuid():N}");
        var gameDir = Path.Combine(root, "GameDir");
        Directory.CreateDirectory(gameDir);

        var builtMods = new List<Fallout4Mod>();
        var explicitPlugins = new List<LoadOrderEntry>();
        var i = 0;
        foreach (var (name, _, enabled, configure, writeParams, origin) in _plugins)
        {
            var mod = new Fallout4Mod(ModKey.FromFileName(name), Fallout4Release.Fallout4);
            configure?.Invoke(mod, builtMods.AsReadOnly());

            string targetPath;
            if (implicitNames.Contains(name) || cccNames.Contains(name))
            {
                targetPath = Path.Combine(gameDir, name);
            }
            else
            {
                var folder = Path.Combine(root, $"mod-{i:D2}-{Path.GetFileNameWithoutExtension(name)}");
                Directory.CreateDirectory(folder);
                targetPath = Path.Combine(folder, name);
                explicitPlugins.Add(new LoadOrderEntry(name, targetPath, origin, explicitPlugins.Count, enabled, Winning: true));
            }

            mod.WriteToBinary(targetPath, writeParams);
            builtMods.Add(mod);
            i++;
        }

        // Same one-level-above-Data placement as Build() — gameDir is what Reconcile
        // treats as the Data path, so the catalog belongs in its parent, root.
        WriteCreationClubCatalog(root);

        return new ScatteredFixtureData(root, gameDir, explicitPlugins);
    }

    private void WriteCreationClubCatalog(string folder)
    {
        if (_cccCatalog.Count == 0) return;
        File.WriteAllText(Path.Combine(folder, "Fallout4.ccc"), string.Join("\n", _cccCatalog) + "\n");
    }
}

/// <summary>A fixture whose plugins all live in one folder, the game's own <c>Data</c>, where
/// implicit masters, DLC and Creation Club content really sit. <see cref="Plugins"/> is the
/// load order to hand <c>Reconcile</c>.</summary>
public sealed record PluginFixtureData(
    string DataFolder, IReadOnlyList<LoadOrderEntry> Plugins, string CleanupRoot) : IDisposable
{
    // The MO2 instance root this fixture stands in for (ADR-0001): the temp directory the Data
    // folder sits under, never the Data folder itself.
    public string InstanceRoot => CleanupRoot;

    public void Dispose() => Directory.Delete(CleanupRoot, recursive: true);
}

/// <summary>A plugin-data fixture loadable through the API test host, with a construction hook so
/// generic consumers need no bare <c>new()</c> constraint.</summary>
public interface IApiPluginFixture<TSelf> : IDisposable where TSelf : IApiPluginFixture<TSelf>
{
    string DataFolder { get; }
    IReadOnlyList<LoadOrderEntry> Plugins { get; }
    string InstanceRoot { get; }
    static abstract TSelf Create();
}

public sealed record ScatteredFixtureData(
    string Root, string GameDirectory, IReadOnlyList<LoadOrderEntry> Plugins) : IDisposable
{
    // The MO2 instance root this fixture stands in for (ADR-0001), also its cleanup root.
    public string InstanceRoot => Root;

    public void Dispose() => Directory.Delete(Root, recursive: true);
}
