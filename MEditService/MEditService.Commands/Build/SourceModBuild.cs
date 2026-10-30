using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.ModFolderAdapter;
using MEditService.PluginAdapter;
using MEditService.SourceAdapter;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using SharpCompress.Common;

namespace MEditService.Commands.Build;

/// <summary>One source mod's plugins and archives made from its source into its folder, or the mod refused.</summary>
internal sealed class SourceModBuild
{
    private readonly CompilePluginHandler _compile;
    private readonly LoadOrderHolder _loadOrder;
    private readonly ISourceAdapter _source;
    private readonly IModFolderRepository _modFolders;
    private readonly IPluginAdapter _plugins;

    internal SourceModBuild(
        CompilePluginHandler compile, LoadOrderHolder loadOrder, ISourceAdapter source, IModFolderRepository modFolders, IPluginAdapter plugins) =>
        (_compile, _loadOrder, _source, _modFolders, _plugins) = (compile, loadOrder, source, modFolders, plugins);

    /// <summary>Compiled against the held load order. Everything that refuses the mod is checked before its first write.</summary>
    internal async Task<ItemAnswer<BuildRefusal, ModBuildOutcome>> BuildAsync(ModToBuild mod, InstanceToBuild instance)
    {
        if (_compile.WhyNoPluginCompiles() is { } none) return Refused(WholeCompileRefused(none.Refusal), none.Message);
        var loadOrder = _loadOrder.Require();
        if (!_source.SourceToBuild(mod.SourceFolder).Holds(out var source, out var unread))
            return Refused(BuildRefusal.SourceUnreadable, unread.Reason);

        var written = new FolderWrite(_modFolders, mod.Folder, mod.Exclude, instance.ExclusionMark);
        var taken = mod.Taken.ToHashSet(StringComparer.OrdinalIgnoreCase);
        var plugins = Placed(loadOrder, mod, source.Plugins);
        var compiled = CompiledPaths(loadOrder, plugins, [.. source.Assets.Select(asset => asset.Path)]);
        var assets = source.Assets
            .Where(asset => !compiled.Contains(asset.Path) && !taken.Contains(written.PathOf(asset.Path)))
            .ToDictionary(asset => asset.Path, StringComparer.OrdinalIgnoreCase);
        List<(ArchiveToPack Archive, List<Asset> Files)> archives = [];
        foreach (var archive in mod.Archives)
        {
            List<Asset> files = [];
            foreach (var file in archive.Files.Distinct(StringComparer.OrdinalIgnoreCase))
            {
                if (assets.TryGetValue(file, out var asset)) files.Add(asset);
                else if (taken.Contains(written.PathOf(file))) files.Add(new Asset(file, () => _modFolders.OpenFile(mod.Folder, written.PathOf(file))));
                else return Refused(BuildRefusal.ArchiveFileNotAnAsset, $"'{archive.Path}' takes '{file}', which is not an asset of its source.");
            }
            archives.Add((archive, files));
        }

        var packed = mod.Archives.SelectMany(archive => archive.Files).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var loose = assets.Values.Where(asset => !packed.Contains(asset.Path)).ToList();
        try
        {
            foreach (var asset in loose)
            {
                written.Write(asset.Path, output =>
                {
                    using var content = asset.Open();
                    content.CopyTo(output);
                });
            }
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or SharpCompressException)
        {
            return ItemAnswer<BuildRefusal, ModBuildOutcome>.Landed(new ModBuildOutcome(
                [], [], [], [.. written.Overwritten.Order(StringComparer.Ordinal)],
                $"The build stopped before compiling, as a file could not be read or written: {e.Message}"));
        }

        var (landed, refused) = await CompileAsync(loadOrder, mod, plugins, written);
        var archivesRefused = Pack(mod, archives, instance.Archives, written);

        Dictionary<string, bool> made = new(StringComparer.OrdinalIgnoreCase);
        foreach (var asset in loose) made[written.PathOf(asset.Path)] = true;
        foreach (var (path, vouched) in CompiledFiles(loadOrder, mod, plugins, landed)) made[path] = vouched;
        foreach (var archive in mod.Archives.Select(archive => archive.Path)) made[written.PathOf(archive)] = archivesRefused.All(refusal => refusal.Item != archive);
        return ItemAnswer<BuildRefusal, ModBuildOutcome>.Landed(new ModBuildOutcome(
            landed, refused, archivesRefused, [.. written.Overwritten.Order(StringComparer.Ordinal)], null, source.Uncommitted, source.Unpushed)
        {
            Made = [.. made.Select(file => new MadeFile(file.Key, file.Value)).OrderBy(file => file.Path, StringComparer.Ordinal)],
        });
    }

    // Each file compile writes for the mod's plugins that the folder holds, as this build made it when its plugin compiled.
    private IEnumerable<(string Path, bool Vouched)> CompiledFiles(
        LoadOrderSnapshot loadOrder, ModToBuild mod, IReadOnlyList<RegisteredPlugin> plugins,
        IReadOnlyList<ItemLanded<PluginAddress, IReadOnlyList<CompileDiagnostic>>> landed)
    {
        var inFolder = _modFolders.FilePaths(mod.Folder);
        var compiled = landed.Select(item => item.Item).ToHashSet(PluginAddress.Comparer);
        return plugins.Where(plugin => _plugins.Exists(plugin.Path))
            .SelectMany(plugin => _plugins.WrittenByCompile(plugin, inFolder, loadOrder.GameRelease).Select(path => (path, compiled.Contains(plugin.Key))));
    }

    // A plugin's file is in the mod's folder whether or not the load order holds it yet, as a fresh clone's does not
    // (mods.md, Build, story 7). Its source folder is the one this build reads.
    private List<RegisteredPlugin> Placed(LoadOrderSnapshot loadOrder, ModToBuild mod, IReadOnlyList<string> names)
    {
        var provider = new PluginProvider.FromMod(mod.Name, mod.Folder, mod.SourceFolder);
        return
        [
            .. names.Select(name => loadOrder.Plugin(new PluginAddress(name, mod.Name)) is { } registered
                ? registered with { Provider = provider }
                : new RegisteredPlugin(name, mod.Name, _plugins.PathOfEmpty(ModKey.FromFileName(name), mod.Folder), provider, Line: null, PluginStrings.None)),
        ];
    }

    // A plugin with no file yet tells nothing of its strings until it compiles.
    private HashSet<string> CompiledPaths(LoadOrderSnapshot loadOrder, IReadOnlyList<RegisteredPlugin> plugins, IReadOnlyList<string> paths) =>
        plugins
            .SelectMany(plugin => _plugins.Exists(plugin.Path) ? _plugins.WrittenByCompile(plugin, paths, loadOrder.GameRelease) : [plugin.Name])
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

    private async Task<(IReadOnlyList<ItemLanded<PluginAddress, IReadOnlyList<CompileDiagnostic>>> Landed, IReadOnlyList<ItemRefused<PluginAddress, CompileRefusal>> Refused)> CompileAsync(
        LoadOrderSnapshot loadOrder, ModToBuild mod, IReadOnlyList<RegisteredPlugin> plugins, FolderWrite written)
    {
        var twins = plugins.GroupBy(plugin => plugin.Name, StringComparer.OrdinalIgnoreCase).Where(named => named.Count() > 1).ToList();
        List<RegisteredPlugin> compilable = [.. plugins.Except(twins.SelectMany(named => named))];
        var changedOutside = compilable
            .Where(plugin => ChangedOutside(plugin, loadOrder.GameRelease))
            .ToDictionary(plugin => plugin.Key, PluginAddress.Comparer);
        var before = changedOutside.Count == 0 ? new Dictionary<string, string>() : _modFolders.Hashes(mod.Folder);
        var compiled = await _compile.CompileAsync(compilable);
        var landedChangedOutside = compiled.Landed.Select(landed => changedOutside.GetValueOrDefault(landed.Item)).OfType<RegisteredPlugin>().ToList();
        if (landedChangedOutside.Count > 0)
        {
            var after = _modFolders.Hashes(mod.Folder);
            foreach (var plugin in landedChangedOutside)
            {
                written.Overwritten.Add(_modFolders.PathIn(mod.Folder, plugin.Path));
                written.Overwritten.AddRange(_plugins.WrittenByCompile(plugin, [.. before.Keys], loadOrder.GameRelease)
                    .Where(path => path != _modFolders.PathIn(mod.Folder, plugin.Path) && before[path] != after.GetValueOrDefault(path)));
            }
        }

        return (compiled.Landed, [.. twins.SelectMany(TwinsRefused), .. compiled.Refused]);
    }

    private static IEnumerable<ItemRefused<PluginAddress, CompileRefusal>> TwinsRefused(IEnumerable<RegisteredPlugin> twins)
    {
        var named = string.Join(" and ", twins.Select(plugin => $"'{plugin.Name}'"));
        return twins.Select(plugin => new ItemRefused<PluginAddress, CompileRefusal>(plugin.Key, CompileRefusal.TwinPluginSources,
            $"{plugin.Name} cannot be compiled: the plugin sources {named} differ only in case, and one mod folder cannot hold them on Windows."));
    }

    private bool ChangedOutside(RegisteredPlugin plugin, GameRelease release) =>
        _plugins.Exists(plugin.Path)
        && plugin.Provider is PluginProvider.FromMod provider
        && (_source.Open(provider, release) is not { } repository
            || !ExternalChangeCheck.MatchesLastWrite(repository, plugin.Key, _plugins.HashOf(plugin.Path)));

    // mods.md, Build, story 2: a packed file is not loose in the output, so a taken file an archive packs leaves the folder.
    private List<ItemRefused<string, ArchiveRefusal>> Pack(
        ModToBuild mod, IReadOnlyList<(ArchiveToPack Archive, List<Asset> Files)> archives, ArchiveVariants? variants, FolderWrite written)
    {
        var packer = new ArchivePacker(_modFolders);
        var taken = mod.Taken.ToHashSet(StringComparer.OrdinalIgnoreCase);
        List<ItemRefused<string, ArchiveRefusal>> refused = [];
        foreach (var (archive, files) in archives)
        {
            if (variants is null)
            {
                refused.Add(new ItemRefused<string, ArchiveRefusal>(archive.Path, ArchiveRefusal.VariantNotWritten,
                    $"'{archive.Path}' was not packed: Modbench packs no archive for this game."));
                continue;
            }

            var variant = files.All(file => file.Path.EndsWith(".dds", StringComparison.OrdinalIgnoreCase)) ? variants.Textures : variants.General;
            var at = written.PathOf(archive.Path);
            if (!packer.Pack(mod.Folder, at, files, variant).Holds(out var replaced, out var refusal))
            {
                refused.Add(new ItemRefused<string, ArchiveRefusal>(archive.Path, refusal.Reason, $"'{archive.Path}' was not packed: {refusal.Message}"));
                continue;
            }
            if (replaced) written.Overwritten.Add(at);
            try
            {
                foreach (var file in files.Select(file => written.PathOf(file.Path)).Where(taken.Contains)) _modFolders.DeleteFile(mod.Folder, file);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                refused.Add(new ItemRefused<string, ArchiveRefusal>(archive.Path, ArchiveRefusal.NotWritten,
                    $"'{archive.Path}' was packed, and a file it took stays loose in the folder: {e.Message}"));
            }
        }

        return refused;
    }

    private static BuildRefusal WholeCompileRefused(CompileRefusal refusal) => refusal switch
    {
        CompileRefusal.NoLoadOrder => BuildRefusal.NoLoadOrder,
        CompileRefusal.GitUnavailable => BuildRefusal.GitUnavailable,
        _ => throw new ArgumentOutOfRangeException(nameof(refusal), refusal, "A compile refuses a whole selection only for want of a load order or of git."),
    };

    private static ItemAnswer<BuildRefusal, ModBuildOutcome> Refused(BuildRefusal refusal, string why) =>
        ItemAnswer<BuildRefusal, ModBuildOutcome>.Refused(refusal, $"was not built: {why}");
}
