using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.ModFolderAdapter;
using MEditService.PluginAdapter;
using MEditService.SourceAdapter;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using SharpCompress.Common;

namespace MEditService.Commands.Build;

/// <summary>One source mod's folder written from its source as its manifest says, or the mod refused.</summary>
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

    /// <summary>Compiled against the held load order. Everything that refuses the mod is checked before its first write
    /// (mods.md, Build, story 4).</summary>
    internal async Task<ItemAnswer<BuildStop, ModBuildOutcome>> BuildAsync(ModToBuild mod, InstanceToBuild instance)
    {
        if (_compile.WhyNoPluginCompiles() is { } none) return Refused(WholeCompileRefused(none.Refusal), none.Message);
        var loadOrder = _loadOrder.Require();
        if (!_modFolders.ReadSourceManifest(mod.SourceFolder).Holds(out var held, out var why)) return Refused(BuildRefusal.SourceUnreadable, $"{why}.");
        if (held is not { } configured) return Refused(BuildRefusal.SourceUnreadable, $"'{mod.SourceFolder}' holds no manifest.");
        var folderName = _modFolders.FolderName(mod.Folder);
        if (!string.Equals(configured.Output, folderName, StringComparison.OrdinalIgnoreCase))
        {
            return Refused(BuildRefusal.OutputNotThisMod,
                $"its manifest names the output folder '{configured.Output}', not its folder '{folderName}'.");
        }
        if (mod.Made is { } madeBeforeSteps) return StepsRan(mod, instance, configured, madeBeforeSteps);
        if (ToolsWithoutTask.Why(configured, instance.Tasks) is { } noTask) return Refused(BuildRefusal.NoTaskForTool, $"{noTask}.");
        if (!_source.SourceToBuild(mod.SourceFolder).Holds(out var source, out var unread))
            return Refused(BuildRefusal.SourceUnreadable, unread.Reason);

        var plugins = Placed(loadOrder, mod, source.Plugins);
        var compiled = CompiledPaths(loadOrder, plugins, [.. source.Assets.Select(asset => asset.Path)]);
        var assets = source.Assets.Where(asset => !compiled.Contains(asset.Path)).ToDictionary(asset => asset.Path, StringComparer.OrdinalIgnoreCase);
        using var taken = new TakenFromPackages(_modFolders);
        var lacking = taken.Lacking(configured, mod, instance.GameFolder);
        if (lacking is not null) return lacking;
        try
        {
            foreach (var asset in taken.Extract()) assets[asset.Path] = asset;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or InvalidDataException)
        {
            return ItemAnswer<BuildStop, ModBuildOutcome>.Landed(new ModBuildOutcome([], [], [], [], $"The build stopped before compiling, as an installation file could not be read: {e.Message}"));
        }
        var notAnAsset = configured.Archives.SelectMany(archive => archive.Files.Select(file => (Archive: archive.Path, File: file)))
            .FirstOrDefault(packed => !assets.ContainsKey(packed.File));
        if (notAnAsset.File is not null)
            return Refused(BuildRefusal.ArchiveFileNotAnAsset, $"'{notAnAsset.Archive}' takes '{notAnAsset.File}', which is not an asset of its source.");

        var written = new FolderWrite(_modFolders, mod.Folder, configured.Exclude, instance.ExclusionMark);

        var packed = configured.Archives.SelectMany(archive => archive.Files).ToHashSet(StringComparer.OrdinalIgnoreCase);
        try
        {
            foreach (var asset in assets.Values.Where(asset => !packed.Contains(asset.Path)))
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
            return ItemAnswer<BuildStop, ModBuildOutcome>.Landed(new ModBuildOutcome(
                [], [], [], [.. written.Overwritten.Order(StringComparer.Ordinal)],
                $"The build stopped before compiling, as a file could not be read or written: {e.Message}"));
        }

        var (landed, refused) = await CompileAsync(loadOrder, mod, plugins, written);
        var archivesRefused = Pack(mod, configured.Archives, assets, instance.Archives, written);

        MadeFiles made = new();
        foreach (var asset in assets.Values.Where(asset => !packed.Contains(asset.Path))) made.Add(written.PathOf(asset.Path), vouched: true);
        foreach (var (path, vouched) in CompiledFiles(loadOrder, mod, plugins, landed)) made.Add(path, vouched);
        foreach (var archive in configured.Archives.Select(archive => archive.Path))
            made.Add(written.PathOf(archive), vouched: archivesRefused.All(refusal => refusal.Item != archive));

        var (manifest, failure) = Record(mod, instance, configured, made, written);
        return ItemAnswer<BuildStop, ModBuildOutcome>.Landed(new ModBuildOutcome(
            landed, refused, archivesRefused, [.. written.Overwritten.Order(StringComparer.Ordinal)], failure, source.Uncommitted, source.Unpushed, manifest)
        {
            Steps = failure is null ? configured.Steps : [],
        });
    }

    // mods.md, Build, story 1: the manifest's file lines are written once the steps ran, naming each file the build made that
    // the folder still holds.
    private ItemAnswer<BuildStop, ModBuildOutcome> StepsRan(ModToBuild mod, InstanceToBuild instance, Manifest configured, IReadOnlyList<string> made)
    {
        try
        {
            var held = _modFolders.FilePaths(mod.Folder).ToHashSet(StringComparer.Ordinal);
            var manifest = Recorded(mod, configured, made.Where(held.Contains), new FolderWrite(_modFolders, mod.Folder, configured.Exclude, instance.ExclusionMark));
            _modFolders.WriteSourceManifest(mod.SourceFolder, manifest);
            return ItemAnswer<BuildStop, ModBuildOutcome>.Landed(new ModBuildOutcome([], [], [], [], null, Manifest: manifest));
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return ItemAnswer<BuildStop, ModBuildOutcome>.Landed(new ModBuildOutcome([], [], [], [], $"The build could not write its manifest: {e.Message}"));
        }
    }

    private Manifest Recorded(ModToBuild mod, Manifest configured, IEnumerable<string> made, FolderWrite written)
    {
        var kept = configured.Files
            .Where(line => line.Entry is PackageEntry.MadeByStep || configured.PackageOf(line) is ManifestPackage.InstallationFile or ManifestPackage.GameFolder)
            .Select(line => AtItsFolderPath(configured, line, written)).ToList();
        var named = kept.Select(line => line.Path).ToHashSet(StringComparer.Ordinal);
        return configured with
        {
            Packages = [new ManifestPackage.SourceRepository(_modFolders.FolderName(mod.SourceFolder), mod.IsSubmodule), .. configured.Packages.Where(package => package is ManifestPackage.InstallationFile or ManifestPackage.GameFolder)],
            Files = [.. made.Where(path => !named.Contains(path)).Select(path => new ManifestFile(path, new PackageEntry.Held())), .. kept],
            Version = mod.Version,
        };
    }

    private static ManifestFile AtItsFolderPath(Manifest manifest, ManifestFile line, FolderWrite written)
    {
        var at = written.PathOf(line.Path);
        return (manifest.BytesOf(line), manifest.PackageOf(line)) switch
        {
            (FileBytes.InInstallationFile held, _) => ManifestFile.In(held.Name, at, held.Path),
            (FileBytes.InGameFolder held, ManifestPackage.GameFolder package) => ManifestFile.In(package.Name, at, held.Path),
            _ => line,
        };
    }

    private sealed class MadeFiles
    {
        private readonly HashSet<string> _all = new(StringComparer.OrdinalIgnoreCase);
        private readonly HashSet<string> _refused = new(StringComparer.OrdinalIgnoreCase);

        public void Add(string path, bool vouched)
        {
            _all.Add(path);
            if (!vouched) _refused.Add(path);
            else _refused.Remove(path);
        }

        public bool Contains(string path) => _all.Contains(path);

        public bool IsVouchedFor(string path) => !_refused.Contains(path);
    }

    // The manifest is written last, in the mod's repository (mods.md, Build, story 1), and names only the files the build
    // made (story 3). A manifest with steps is written once they ran.
    private (Manifest? Recorded, string? Failure) Record(ModToBuild mod, InstanceToBuild instance, Manifest configured, MadeFiles made, FolderWrite written)
    {
        try
        {
            var read = _modFolders.Files(mod.Folder, mod.MetadataFiles.ToHashSet(StringComparer.Ordinal), instance.StatCache);
            var files = read.Files.Where(file => made.Contains(file.Path)).ToList();
            var manifest = Recorded(mod, configured, files.Select(file => file.Path), written);
            if (configured.Steps.Count == 0) _modFolders.WriteSourceManifest(mod.SourceFolder, manifest);
            // A stat cache that cannot be written leaves each file to be read again, and the mod's status says why.
            _ = _modFolders.KeepInStatCache(
                read, manifest, files.Where(file => made.IsVouchedFor(file.Path)).ToDictionary(file => file.Path, file => file.Hash, StringComparer.Ordinal));
            return (manifest, null);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return (null, $"The build could not write its manifest: {e.Message}");
        }
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
        var before = changedOutside.Count == 0 ? [] : HashesIn(mod);
        var compiled = await _compile.CompileAsync(compilable);
        var landedChangedOutside = compiled.Landed.Select(landed => changedOutside.GetValueOrDefault(landed.Item)).OfType<RegisteredPlugin>().ToList();
        if (landedChangedOutside.Count > 0)
        {
            var after = HashesIn(mod);
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

    private Dictionary<string, string> HashesIn(ModToBuild mod) =>
        _modFolders.Files(mod.Folder, new HashSet<string>(), statCache: null).Files.ToDictionary(file => file.Path, file => file.Hash, StringComparer.Ordinal);

    private bool ChangedOutside(RegisteredPlugin plugin, GameRelease release) =>
        _plugins.Exists(plugin.Path)
        && plugin.Provider is PluginProvider.FromMod provider
        && (_source.Open(provider, release) is not { } repository
            || !ExternalChangeCheck.MatchesLastWrite(repository, plugin.Key, _plugins.HashOf(plugin.Path)));

    private List<ItemRefused<string, ArchiveRefusal>> Pack(
        ModToBuild mod, IReadOnlyList<ManifestArchive> archives, Dictionary<string, Asset> assets, ArchiveVariants? variants, FolderWrite written)
    {
        var packer = new ArchivePacker(_modFolders);
        List<ItemRefused<string, ArchiveRefusal>> refused = [];
        foreach (var archive in archives)
        {
            if (variants is null)
            {
                refused.Add(new ItemRefused<string, ArchiveRefusal>(archive.Path, ArchiveRefusal.VariantNotWritten,
                    $"'{archive.Path}' was not packed: Modbench packs no archive for this game."));
                continue;
            }

            List<Asset> files = [.. archive.Files.Distinct(StringComparer.OrdinalIgnoreCase).Select(file => assets[file])];
            var variant = files.All(file => file.Path.EndsWith(".dds", StringComparison.OrdinalIgnoreCase)) ? variants.Textures : variants.General;
            var at = written.PathOf(archive.Path);
            if (!packer.Pack(mod.Folder, at, files, variant).Holds(out var replaced, out var refusal))
                refused.Add(new ItemRefused<string, ArchiveRefusal>(archive.Path, refusal.Reason, $"'{archive.Path}' was not packed: {refusal.Message}"));
            else if (replaced)
                written.Overwritten.Add(at);
        }

        return refused;
    }

    private static BuildRefusal WholeCompileRefused(CompileRefusal refusal) => refusal switch
    {
        CompileRefusal.NoLoadOrder => BuildRefusal.NoLoadOrder,
        CompileRefusal.GitUnavailable => BuildRefusal.GitUnavailable,
        _ => throw new ArgumentOutOfRangeException(nameof(refusal), refusal, "A compile refuses a whole selection only for want of a load order or of git."),
    };

    private static ItemAnswer<BuildStop, ModBuildOutcome> Refused(BuildRefusal refusal, string why) =>
        ItemAnswer<BuildStop, ModBuildOutcome>.Refused(new BuildStop(refusal), $"was not built: {why}");
}
