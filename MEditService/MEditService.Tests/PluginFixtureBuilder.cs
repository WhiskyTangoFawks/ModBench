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
    // #434: names for a fixture Fallout4.ccc, in the order given — a Creation Club catalog entry,
    // not a plugins.txt line. Kept separate from _plugins' Listed flag: BuildScattered ignores
    // Listed entirely (it has no plugins.txt), so a test controls "also *-listed" by hand-appending
    // an ExplicitPluginInput, the same way its sibling missing/unparseable-plugin tests already do.
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

    /// <summary>Fixture Fallout4.ccc catalog (#434): written into the data folder (<see cref="Build"/>)
    /// or the game directory (<see cref="BuildScattered"/>) alongside whatever plugins <c>WithPlugin</c>
    /// declared. Names are written in the given order — catalog order is part of what the fix under
    /// test must preserve.</summary>
    public PluginFixtureBuilder WithCreationClubCatalog(params string[] names)
    {
        _cccCatalog.AddRange(names);
        return this;
    }

    public PluginFixtureData Build()
    {
        // #434: Fallout4.ccc lives one directory *above* the Data folder in a real install —
        // Mutagen's own CreationClubListings.GetListingsPath resolves it that way — so the fixture
        // needs a root above dataFolder to hold it, the same shape BuildScattered's root/gameDir
        // already has. Root is unique per fixture instance (never the shared OS temp directory
        // itself), so a fixture's catalog can never bleed into an unrelated fixture built alongside
        // it in a parallel test run.
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

        // #592: there is no plugins.txt load path left to write one for — the ordered explicit list
        // *is* the load order, exactly as it is on the scattered path. `Listed` is what puts a plugin
        // in it (a file on disk that no line names is not in the load order) and `Enabled` is the `*`
        // prefix, i.e. Participates.
        var explicitPlugins = _plugins
            .Where(p => p.Listed)
            .Select(p => new ExplicitPluginInput(p.Name, Path.Combine(dataFolder, p.Name), p.Origin, p.Enabled))
            .ToList();

        WriteCreationClubCatalog(root);

        return new PluginFixtureData(dataFolder, explicitPlugins, root);
    }

    /// <summary>
    /// Builds the plugins into <em>scattered</em> physical locations to mirror an MO2 instance:
    /// implicit masters (e.g. Fallout4.esm) land in a single game directory; every other plugin
    /// gets its own folder. Returns the game directory plus the ordered explicit
    /// <c>{Name, Path, Origin, Participates}</c> list (non-implicit plugins, in declared order)
    /// for <c>LoadExplicit</c>. <c>WithPlugin(enabled: false)</c> — the same flag that writes a
    /// prefix-less plugins.txt line in <see cref="Build"/> — becomes <c>Participates: false</c>
    /// here, since the explicit list is what carries the `*` prefix on this path (#270).
    /// </summary>
    public ScatteredFixtureData BuildScattered()
    {
        var implicitNames = Implicits.Get(GameRelease.Fallout4).Listings
            .Select(l => l.FileName.ToString())
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        // #434: a cataloged CC plugin's file lives in the game directory too — never a mod
        // folder — the same as an implicit master. A test that also wants it to arrive via the
        // explicit list (simulating a plugins.txt `*` line pointing at the Data-folder copy) adds
        // that ExplicitPluginInput by hand afterwards, same convention this method already uses for
        // the missing/unparseable-plugin tests.
        var cccNames = _cccCatalog.ToHashSet(StringComparer.OrdinalIgnoreCase);

        var root = Path.Combine(Path.GetTempPath(), $"{_prefix}-scatter-{Guid.NewGuid():N}");
        var gameDir = Path.Combine(root, "GameDir");
        Directory.CreateDirectory(gameDir);

        var builtMods = new List<Fallout4Mod>();
        var explicitPlugins = new List<ExplicitPluginInput>();
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
                explicitPlugins.Add(new ExplicitPluginInput(name, targetPath, origin, enabled));
            }

            mod.WriteToBinary(targetPath, writeParams);
            builtMods.Add(mod);
            i++;
        }

        // #434: same one-level-above-Data placement as Build() — gameDir is what LoadExplicit
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

/// <summary>
/// A fixture whose plugins all live in one folder — the game's own <c>Data</c>, which is where
/// implicit masters, DLC and Creation Club content really do sit. <see cref="Plugins"/> is the
/// ordered load order to hand <c>LoadExplicit</c>, the one load there is (#592).
/// </summary>
public sealed record PluginFixtureData(
    string DataFolder, IReadOnlyList<ExplicitPluginInput> Plugins, string CleanupRoot) : IDisposable
{
    /// <summary>The MO2 instance root this fixture stands in for (#592 / ADR-0001) — the temp
    /// directory the Data folder sits under, never the Data folder itself. Only tests that want a
    /// <i>persistent</i> index pass it to a load; omitting it asks for an in-memory one, which is
    /// what the great majority of fixtures want.</summary>
    public string InstanceRoot => CleanupRoot;

    public void Dispose() => Directory.Delete(CleanupRoot, recursive: true);
}

/// <summary>
/// Shared shape of a plugin-data fixture loadable through the API test host: a data folder + the
/// ordered load order built by <see cref="PluginFixtureBuilder"/>, plus a construction hook so
/// generic consumers (<c>LoadedApiFixture&lt;TPlugin&gt;</c>) don't need a bare <c>new()</c>
/// constraint.
/// </summary>
public interface IApiPluginFixture<TSelf> : IDisposable where TSelf : IApiPluginFixture<TSelf>
{
    string DataFolder { get; }
    IReadOnlyList<ExplicitPluginInput> Plugins { get; }
    string InstanceRoot { get; }
    static abstract TSelf Create();
}

public sealed record ScatteredFixtureData(
    string Root, string GameDirectory, IReadOnlyList<ExplicitPluginInput> Plugins) : IDisposable
{
    /// <summary>The MO2 instance root this fixture stands in for (#592 / ADR-0001) — the directory
    /// the scattered mod folders sit under. Named for what a load asks for, since
    /// <see cref="Root"/> is also the fixture's own cleanup root.</summary>
    public string InstanceRoot => Root;

    public void Dispose() => Directory.Delete(Root, recursive: true);
}
