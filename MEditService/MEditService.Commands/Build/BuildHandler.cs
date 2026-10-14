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
        var installed = mod.InstallationFiles.SelectMany(file => file.Entries.Select(entry => (File: file, Entry: entry.Path))).ToList();
        var compiled = CompiledPaths(loadOrder, plugins, [.. installed.Select(entry => entry.Entry), .. source.Assets.Select(asset => asset.Path)]);
        var assets = source.Assets.Where(asset => !compiled.Contains(asset.Path)).ToDictionary(asset => asset.Path, StringComparer.OrdinalIgnoreCase);
        var notAnAsset = source.Archives.SelectMany(archive => archive.Files.Select(file => (Archive: archive.Path, File: file)))
            .FirstOrDefault(packed => !assets.ContainsKey(packed.File));
        if (notAnAsset.File is not null)
            return Refused(mod, BuildRefusal.ArchiveFileNotAnAsset, $"'{notAnAsset.Archive}' takes '{notAnAsset.File}', which is not an asset of its source.");

        var written = new FolderWrite(_modFolders, mod.Folder, source.Exclude, instance.ExcludedSuffix);
        if (WhyTheBaseIsNotKnown(mod, installed, written) is { } unknown) return unknown;

        var packed = source.Archives.SelectMany(archive => archive.Files).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var looseBase = installed.Where(entry => !compiled.Contains(entry.Entry) && !assets.ContainsKey(entry.Entry))
            .GroupBy(entry => entry.Entry, StringComparer.OrdinalIgnoreCase).Select(paths => paths.Last())
            .GroupBy(entry => entry.File, entry => entry.Entry);
        try
        {
            foreach (var fromOne in looseBase) WriteBase(fromOne.Key, fromOne.ToHashSet(StringComparer.OrdinalIgnoreCase), written);
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
            return ItemAnswer<BuildRefusal, BuiltMod>.Landed(new BuiltMod(
                [], [], [], [.. written.Overwritten.Order(StringComparer.Ordinal)],
                $"The build stopped before compiling, as a file could not be read or written: {e.Message}"));
        }

        var (landed, refused) = await CompileAsync(loadOrder, mod, plugins, written);
        var archivesRefused = Pack(mod, source.Archives, assets, instance.Archives, written);
        return ItemAnswer<BuildRefusal, BuiltMod>.Landed(new BuiltMod(
            landed, refused, archivesRefused, [.. written.Overwritten.Order(StringComparer.Ordinal)], Failure: null));
    }

    private HashSet<string> CompiledPaths(LoadOrderSnapshot loadOrder, IReadOnlyList<PluginAddress> plugins, IReadOnlyList<string> paths) =>
        plugins.Select(loadOrder.Plugin).OfType<RegisteredPlugin>()
            .SelectMany(plugin => _plugins.WrittenByCompile(plugin, paths, loadOrder.GameRelease))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

    // The base is each installation file's entries at their own paths (mods.md, Build, story 1). A folder that holds
    // them elsewhere, or not at all, says nothing of where its files come from, so no base is guessed.
    private ItemAnswer<BuildRefusal, BuiltMod>? WhyTheBaseIsNotKnown(
        ModToBuild mod, IReadOnlyList<(InstallationFile File, string Entry)> installed, FolderWrite written)
    {
        if (mod.InstallationFiles.FirstOrDefault(file => !_modFolders.InstallationFileExists(file.Path)) is { } missing)
        {
            return Refused(mod, BuildRefusal.InstallationFileMissing,
                $"its installation file '{missing.Path}' is gone.");
        }

        var inFolder = _modFolders.FilePaths(mod.Folder).ToHashSet(StringComparer.OrdinalIgnoreCase);
        if (installed.FirstOrDefault(entry => !inFolder.Contains(written.PathOf(entry.Entry))) is { File: { } file, Entry: { } entry })
        {
            return Refused(mod, BuildRefusal.BaseNotKnown,
                $"'{_modFolders.InstallationFileName(file.Path)}' installs '{entry}', which its folder does not hold at that path, " +
                "so build cannot yet tell where its files come from.");
        }

        return null;
    }

    private void WriteBase(InstallationFile installed, HashSet<string> entries, FolderWrite written)
    {
        using var archive = _modFolders.OpenInstallationFile(installed.Path);
        ArchiveExtractor.Extract(archive, (entry, content) =>
        {
            if (entries.Contains(entry)) written.Write(entry, content.CopyTo);
        });
    }

    private async Task<(IReadOnlyList<ItemLanded<PluginAddress, IReadOnlyList<CompileDiagnostic>>> Landed, IReadOnlyList<ItemRefused<PluginAddress, CompileRefusal>> Refused)> CompileAsync(
        LoadOrderSnapshot loadOrder, ModToBuild mod, IReadOnlyList<PluginAddress> plugins, FolderWrite written)
    {
        var changedOutside = plugins.Select(loadOrder.Plugin).OfType<RegisteredPlugin>()
            .Where(plugin => ChangedOutside(plugin, loadOrder.GameRelease))
            .ToDictionary(plugin => plugin.Key, PluginAddress.Comparer);
        var before = changedOutside.Count == 0 ? [] : HashesIn(mod);
        var compiled = await _compile.CompileAsync(plugins);
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

        return (compiled.Landed, compiled.Refused);
    }

    private Dictionary<string, string> HashesIn(ModToBuild mod) =>
        _modFolders.Files(mod.Folder, mod.Name, new HashSet<string>(), statCache: null).Files.ToDictionary(file => file.Path, file => file.Hash, StringComparer.Ordinal);

    private bool ChangedOutside(RegisteredPlugin plugin, GameRelease release) =>
        _plugins.Exists(plugin.Path)
        && plugin.Provider is PluginProvider.FromMod provider
        && (_source.Open(provider, release) is not { } repository
            || !ExternalChangeCheck.MatchesLastWrite(repository, plugin.Key, _plugins.HashOf(plugin.Path)));

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
