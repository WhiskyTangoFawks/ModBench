using MEditService.LoadOrder;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Binary.Parameters;

namespace MEditService.TestSupport;

public sealed class PluginFixtureBuilder(string prefix = "medit")
{
    private readonly string _prefix = prefix;
    private readonly List<(string Name, bool Listed, bool Enabled, Action<Fallout4Mod, IReadOnlyList<Fallout4Mod>>? Configure, BinaryWriteParameters? WriteParams, string Origin)> _plugins = [];
    // The game's Creation Club list, not a plugins.txt line: BuildScattered ignores Listed entirely,
    // having no plugins.txt.
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
        // in it and `Enabled` is the `*` prefix.
        var explicitPlugins = _plugins
            .Where(p => p.Listed)
            .Select((p, slot) => new LoadOrderEntry(p.Name, Path.Combine(dataFolder, p.Name), p.Origin, slot, p.Enabled, Winning: true))
            .ToList();

        return new PluginFixtureData(dataFolder, OneWinnerPerFilename(explicitPlugins), root);
    }

    public ScatteredFixtureData BuildScattered()
    {
        // The plugins the game loads with no line, in the order it loads them: its masters, then its
        // Creation Club plugins. Their files live in the game directory, never a mod folder.
        var loadedWithNoLine = Implicits.Get(GameRelease.Fallout4).Listings
            .Select(l => l.FileName.ToString())
            .Concat(_cccCatalog)
            .Where(name => _plugins.Exists(p => p.Name.Equals(name, StringComparison.OrdinalIgnoreCase)))
            .ToList();

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
            if (loadedWithNoLine.Contains(name, StringComparer.OrdinalIgnoreCase))
            {
                targetPath = Path.Combine(gameDir, name);
            }
            else
            {
                var folder = Path.Combine(root, $"mod-{i:D2}-{Path.GetFileNameWithoutExtension(name)}");
                Directory.CreateDirectory(folder);
                targetPath = Path.Combine(folder, name);
                explicitPlugins.Add(new LoadOrderEntry(
                    name, targetPath, origin, loadedWithNoLine.Count + explicitPlugins.Count, enabled, Winning: true));
            }

            mod.WriteToBinary(targetPath, writeParams);
            builtMods.Add(mod);
            i++;
        }

        List<LoadOrderEntry> forced = [.. loadedWithNoLine.Select((name, slot) => new LoadOrderEntry(
            name, Path.Combine(gameDir, name), PluginOrigin.DataDirectory, slot, Enabled: true, Winning: true))];
        return new ScatteredFixtureData(root, gameDir, [.. forced, .. OneWinnerPerFilename(explicitPlugins)]);
    }

    // The mod declared later overrides an earlier mod's file of the same name, and the overridden copy
    // loads in the winner's slot, as the instance's snapshot sends it (ADR-0012).
    private static List<LoadOrderEntry> OneWinnerPerFilename(List<LoadOrderEntry> plugins)
    {
        var winners = plugins
            .GroupBy(p => p.Name, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(g => g.Key, g => g.Last(), StringComparer.OrdinalIgnoreCase);
        return [.. plugins.Select(p =>
        {
            var winner = winners[p.Name];
            return ReferenceEquals(winner, p) ? p : p with { Slot = winner.Slot, Winning = false };
        })];
    }
}

/// <summary>A fixture whose plugins all live in one folder, the game's own <c>Data</c>, where
/// implicit masters, DLC and Creation Club content really sit. <see cref="Plugins"/> is the
/// load order to hand <c>Reconcile</c>.</summary>
public sealed record PluginFixtureData(
    string DataFolder, IReadOnlyList<LoadOrderEntry> Plugins, string CleanupRoot) : IDisposable
{
    // The MO2 instance root this fixture stands in for (ADR-0009): the temp directory the Data
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
    // The MO2 instance root this fixture stands in for (ADR-0009), also its cleanup root.
    public string InstanceRoot => Root;

    public void Dispose() => Directory.Delete(Root, recursive: true);
}
