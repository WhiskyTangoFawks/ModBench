using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.ModFolderAdapter;
using MEditService.PluginAdapter;
using MEditService.Ports;
using MEditService.SourceAdapter;
using Mutagen.Bethesda;
using SharpCompress.Common;

namespace MEditService.Commands.Build;

/// <summary>The Build gesture's handler (ADR-0014), the Build engine's way in. The mod is the item of the selection:
/// its folder is written from its source as the build configuration says, or it is refused.</summary>
public sealed class BuildHandler
{
    private readonly CompilePluginHandler _compile;
    private readonly LoadOrderHolder _loadOrder;
    private readonly INotificationPublisher _notifications;
    private readonly ISourceAdapter _source;
    private readonly IModFolderRepository _modFolders;
    private readonly IPluginAdapter _plugins;

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every other handler.
    internal BuildHandler(
        CompilePluginHandler compile, LoadOrderHolder loadOrder, ISourceAdapter source, IModFolderRepository modFolders,
        IPluginAdapter plugins, INotificationPublisher notifications) =>
        (_compile, _loadOrder, _source, _modFolders, _plugins, _notifications) = (compile, loadOrder, source, modFolders, plugins, notifications);

    /// <summary>Each mod's plugins are its source's, compiled where the held load order puts them. Refuses with
    /// <see cref="BuildRefusal.NoLoadOrder"/>, writing nothing, when none is held.</summary>
    public async Task<SelectionResult<string, BuildRefusal, BuiltMod>> BuildAsync(IReadOnlyList<ModToBuild> mods, InstanceToBuild instance)
    {
        if (_loadOrder.Held is not { Snapshot: var loadOrder })
            return SelectionResult<string, BuildRefusal, BuiltMod>.WholeSelectionRefused(BuildRefusal.NoLoadOrder, NoLoadOrderException.DefaultMessage);

        var byName = mods.DistinctBy(mod => mod.Name, StringComparer.OrdinalIgnoreCase).ToDictionary(mod => mod.Name, StringComparer.OrdinalIgnoreCase);
        var done = 0;
        try
        {
            return await ItemWrite.OverAsync(_source, mods.Select(mod => mod.Name), StringComparer.OrdinalIgnoreCase, BuildRefusal.GitUnavailable, async name =>
            {
                _notifications.Publish(new BuildProgressNotification(new BuildProgress(name, done, byName.Count)));
                var built = await BuildModAsync(loadOrder, byName[name], instance);
                done++;
                return built;
            });
        }
        finally
        {
            // Idle at rest, success or failure alike: a client must never keep showing a build that has finished.
            _notifications.Publish(new BuildProgressNotification(new BuildProgress(null, 0, 0)));
        }
    }

    // Everything that refuses the mod is checked before its first write (mods.md, Build, story 4).
    private async Task<ItemAnswer<BuildRefusal, BuiltMod>> BuildModAsync(LoadOrderSnapshot loadOrder, ModToBuild mod, InstanceToBuild instance)
    {
        if (!_source.SourceToBuild(mod.SourceFolder).Holds(out var source, out var unread))
            return Refused(mod, BuildRefusal.SourceUnreadable, unread.Reason);
        var folderName = _modFolders.FolderName(mod.Folder);
        if (!string.Equals(source.Output, folderName, StringComparison.OrdinalIgnoreCase))
        {
            return Refused(mod, BuildRefusal.OutputNotThisMod,
                $"its build configuration names the output folder '{source.Output}', not its folder '{folderName}'.");
        }

        var plugins = source.Plugins.Select(plugin => new PluginAddress(plugin, mod.Name)).ToList();
        var compiled = CompiledPaths(loadOrder, plugins, [.. source.Base.Select(file => file.Path), .. source.Assets.Select(asset => asset.Path)]);
        var assets = source.Assets.Where(asset => !compiled.Contains(asset.Path)).ToDictionary(asset => asset.Path, StringComparer.OrdinalIgnoreCase);
        var notAnAsset = source.Archives.SelectMany(archive => archive.Files.Select(file => (Archive: archive.Path, File: file)))
            .FirstOrDefault(packed => !assets.ContainsKey(packed.File));
        if (notAnAsset.File is not null)
            return Refused(mod, BuildRefusal.ArchiveFileNotAnAsset, $"'{notAnAsset.Archive}' takes '{notAnAsset.File}', which is not an asset of its source.");

        var packed = source.Archives.SelectMany(archive => archive.Files).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var looseBase = source.Base.Where(file => !compiled.Contains(file.Path) && !assets.ContainsKey(file.Path)).ToList();
        if (WhyTheBaseIsNotThere(mod, looseBase) is { } notThere) return notThere;

        var written = new FolderWrite(_modFolders, mod.Folder, source.Exclude, instance.ExcludedSuffix);
        try
        {
            WriteBase(mod, looseBase, written);
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
            return Refused(mod, BuildRefusal.NotWritten, $"a file could not be read or written: {e.Message}");
        }

        var (landed, refused) = await CompileAsync(loadOrder, mod, plugins, written);
        var archivesRefused = Pack(mod, source.Archives, assets, instance.Archives, written);
        return ItemAnswer<BuildRefusal, BuiltMod>.Landed(new BuiltMod(landed, refused, archivesRefused, [.. written.Overwritten.Order(StringComparer.Ordinal)]));
    }

    private HashSet<string> CompiledPaths(LoadOrderSnapshot loadOrder, IReadOnlyList<PluginAddress> plugins, IReadOnlyList<string> paths) =>
        plugins.Select(loadOrder.Plugin).OfType<RegisteredPlugin>()
            .SelectMany(plugin => _plugins.WrittenByCompile(plugin, paths, loadOrder.GameRelease))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

    private ItemAnswer<BuildRefusal, BuiltMod>? WhyTheBaseIsNotThere(ModToBuild mod, IReadOnlyList<BaseFile> baseFiles)
    {
        var installed = InstallationFilesByName(mod);
        foreach (var fromOne in baseFiles.GroupBy(file => file.InstallationFile, StringComparer.OrdinalIgnoreCase))
        {
            if (!installed.TryGetValue(fromOne.Key, out var file) || !_modFolders.InstallationFileExists(file.Path))
            {
                return Refused(mod, BuildRefusal.InstallationFileMissing,
                    $"its base comes from '{fromOne.Key}', which is not among its installation files in the downloads folder.");
            }

            var entries = file.Entries.Select(entry => entry.Path).ToHashSet(StringComparer.OrdinalIgnoreCase);
            if (fromOne.FirstOrDefault(baseFile => !entries.Contains(baseFile.Entry)) is { } absent)
                return Refused(mod, BuildRefusal.EntryMissing, $"'{fromOne.Key}' holds no '{absent.Entry}', which its base takes for '{absent.Path}'.");
        }

        return null;
    }

    private Dictionary<string, InstallationFile> InstallationFilesByName(ModToBuild mod) =>
        mod.InstallationFiles.DistinctBy(file => _modFolders.InstallationFileName(file.Path), StringComparer.OrdinalIgnoreCase)
            .ToDictionary(file => _modFolders.InstallationFileName(file.Path), StringComparer.OrdinalIgnoreCase);

    // An entry the base takes at several paths is read once, and copied from the first.
    private void WriteBase(ModToBuild mod, IReadOnlyList<BaseFile> baseFiles, FolderWrite written)
    {
        var installed = InstallationFilesByName(mod);
        foreach (var fromOne in baseFiles.GroupBy(file => file.InstallationFile, StringComparer.OrdinalIgnoreCase))
        {
            var wanted = fromOne.ToLookup(file => file.Entry, StringComparer.OrdinalIgnoreCase);
            using var archive = _modFolders.OpenInstallationFile(installed[fromOne.Key].Path);
            ArchiveExtractor.Extract(archive, (entry, content) =>
            {
                string? first = null;
                foreach (var path in wanted[entry].Select(file => file.Path))
                {
                    if (first is not { } copied) written.Write(path, content.CopyTo);
                    else written.Write(path, output => written.CopyOf(copied, output));
                    first ??= path;
                }
            });
        }
    }

    // A plugin's own record says what Modbench last wrote, so only one changed outside Modbench is named, not each one
    // its source changed.
    private async Task<(IReadOnlyList<ItemLanded<PluginAddress, IReadOnlyList<CompileDiagnostic>>> Landed, IReadOnlyList<ItemRefused<PluginAddress, CompileRefusal>> Refused)> CompileAsync(
        LoadOrderSnapshot loadOrder, ModToBuild mod, IReadOnlyList<PluginAddress> plugins, FolderWrite written)
    {
        var changedOutside = plugins.Select(loadOrder.Plugin).OfType<RegisteredPlugin>()
            .Where(plugin => ChangedOutside(plugin, loadOrder.GameRelease))
            .ToDictionary(plugin => plugin.Key, plugin => plugin.Path, PluginAddress.Comparer);
        var compiled = await _compile.CompileAsync(plugins);
        foreach (var landed in compiled.Landed)
        {
            if (changedOutside.TryGetValue(landed.Item, out var path))
                written.Overwritten.Add(_modFolders.PathIn(mod.Folder, path));
        }

        return (compiled.Landed, compiled.Refused);
    }

    private bool ChangedOutside(RegisteredPlugin plugin, GameRelease release) =>
        _plugins.HashOf(plugin.Path) is { } there
        && plugin.Provider is PluginProvider.FromMod provider
        && _source.Open(provider, release)?.LastWrittenBinarySha256s(plugin.Key).Holds(out var written, out _) == true
        && !written.Contains(there, StringComparer.OrdinalIgnoreCase);

    private List<ItemRefused<string, ArchiveRefusal>> Pack(
        ModToBuild mod, IReadOnlyList<ArchiveToPack> archives, Dictionary<string, Asset> assets, ArchiveVariants? variants, FolderWrite written)
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

    private static ItemAnswer<BuildRefusal, BuiltMod> Refused(ModToBuild mod, BuildRefusal refusal, string why) =>
        ItemAnswer<BuildRefusal, BuiltMod>.Refused(refusal, $"'{mod.Name}' was not built: {why}");
}
