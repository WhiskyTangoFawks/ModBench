using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.ModFolderAdapter;
using MEditService.PluginAdapter;
using MEditService.SourceAdapter;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Build;

/// <summary>One built-in step of a source mod's build run on its folder or its source folder, or the mod refused.</summary>
internal sealed class SourceModBuild
{
    private readonly CompilePluginHandler _compile;
    private readonly LoadOrderHolder _loadOrder;
    private readonly ISourceAdapter _source;
    private readonly IModFolderRepository _modFolders;
    private readonly IPluginAdapter _plugins;
    private readonly PluginDecompiler _decompiler;

    internal SourceModBuild(
        CompilePluginHandler compile, LoadOrderHolder loadOrder, ISourceAdapter source, IModFolderRepository modFolders, IPluginAdapter plugins,
        PluginDecompiler decompiler) =>
        (_compile, _loadOrder, _source, _modFolders, _plugins, _decompiler) = (compile, loadOrder, source, modFolders, plugins, decompiler);

    /// <summary>Against the held load order. Everything that refuses the mod is checked before the step's first write.</summary>
    internal async Task<ItemAnswer<BuildRefusal, ModBuildOutcome>> BuildAsync(ModToBuild mod, InstanceToBuild instance)
    {
        if (_compile.WhyNoPluginCompiles() is { } none) return Refused(WholeCompileRefused(none.Refusal), none.Message);
        var loadOrder = _loadOrder.Require();
        if (!_source.SourceToBuild(mod.SourceFolder, mod.Step is BuildStep.Copy copy ? copy.Paths : []).Holds(out var source, out var unread))
            return Refused(BuildRefusal.SourceUnreadable, unread.Reason);

        var written = new FolderWrite(_modFolders, mod.Folder, mod.Exclude, instance.ExclusionMark);
        var ran = mod.Step switch
        {
            BuildStep.Copy => ItemAnswer<BuildRefusal, ModBuildOutcome>.Landed(Copied(source.Files, written)),
            BuildStep.Compile compile => ItemAnswer<BuildRefusal, ModBuildOutcome>.Landed(await CompiledAsync(loadOrder, mod, compile.Plugins)),
            BuildStep.Pack pack => Packed(mod, pack.Archives, instance.Archives, written),
            BuildStep.Decompile decompile => await DecompiledAsync(loadOrder, mod, decompile),
            _ => throw new ArgumentOutOfRangeException(nameof(mod), mod.Step, "A build file names no other built-in step."),
        };
        return ran is ItemAnswer<BuildRefusal, ModBuildOutcome>.Wrote { Outcome: var outcome }
            ? ItemAnswer<BuildRefusal, ModBuildOutcome>.Landed(outcome with { Uncommitted = source.Uncommitted, Unpushed = source.Unpushed })
            : ran;
    }

    private static ModBuildOutcome Copied(IReadOnlyList<FileToCopy> files, FolderWrite written)
    {
        try
        {
            foreach (var file in files)
            {
                written.Write(file.Path, output =>
                {
                    using var content = file.Open();
                    content.CopyTo(output);
                });
            }
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return ModBuildOutcome.Stopped($"The build stopped at its copy, as a file could not be read or written: {e.Message}");
        }
        return new ModBuildOutcome([], [], [], null) { Made = MadeOf(files.Select(file => (written.PathOf(file.Path), true))) };
    }

    private async Task<ModBuildOutcome> CompiledAsync(LoadOrderSnapshot loadOrder, ModToBuild mod, IReadOnlyList<string> names)
    {
        var plugins = Placed(loadOrder, mod, names);
        var (landed, refused) = await CompileAsync(plugins);
        return new ModBuildOutcome(landed, refused, [], null) { Made = MadeOf(CompiledFiles(loadOrder, mod, plugins, landed)) };
    }

    // source.md, Build, story 2: the extension takes the loose files an archive packs out of the folder, so the game reads one copy.
    private ItemAnswer<BuildRefusal, ModBuildOutcome> Packed(
        ModToBuild mod, IReadOnlyList<ArchiveToPack> archives, ArchiveVariants? variants, FolderWrite written)
    {
        var held = _modFolders.FilePaths(mod.Folder).ToLookup(path => path, StringComparer.OrdinalIgnoreCase);
        List<(ArchiveToPack Archive, List<string> Loose)> packed = [];
        foreach (var archive in archives)
        {
            List<string> loose = [];
            foreach (var file in archive.Files)
            {
                var at = written.PathOf(file);
                if ((held[at].FirstOrDefault(path => path == at) ?? held[at].FirstOrDefault()) is not { } inFolder)
                    return Refused(BuildRefusal.ArchiveFileNotInFolder, $"'{archive.Path}' takes '{file}', which its folder does not hold.");
                loose.Add(inFolder);
            }
            packed.Add((archive, loose));
        }

        var packer = new ArchivePacker(_modFolders);
        List<ItemRefused<string, ArchiveRefusal>> refused = [];
        List<(string, bool)> made = [];
        List<string> takenOut = [];
        foreach (var (archive, loose) in packed)
        {
            var at = written.PathOf(archive.Path);
            var refusal = variants is null
                ? new PackRefusal(ArchiveRefusal.VariantNotWritten, "Modbench packs no archive for this game.")
                : packer.Pack(mod.Folder, at, [.. archive.Files.Zip(loose, (file, path) => new ArchiveFile(file, () => _modFolders.OpenFile(mod.Folder, path)))],
                    VariantOf(archive, variants));
            made.Add((at, refusal is null));
            if (refusal is null) takenOut.AddRange(loose);
            else refused.Add(new ItemRefused<string, ArchiveRefusal>(archive.Path, refusal.Reason, $"'{archive.Path}' was not packed: {refusal.Message}"));
        }
        return ItemAnswer<BuildRefusal, ModBuildOutcome>.Landed(new ModBuildOutcome([], [], refused, null) { Made = MadeOf(made), Packed = takenOut });
    }

    private static IArchiveVariant VariantOf(ArchiveToPack archive, ArchiveVariants variants) =>
        archive.Files.All(file => file.EndsWith(".dds", StringComparison.OrdinalIgnoreCase)) ? variants.Textures : variants.General;

    private async Task<ItemAnswer<BuildRefusal, ModBuildOutcome>> DecompiledAsync(LoadOrderSnapshot loadOrder, ModToBuild mod, BuildStep.Decompile step)
    {
        var provider = new PluginProvider.FromMod(mod.Name, mod.Folder, mod.SourceFolder);
        List<(RegisteredPlugin Plugin, PluginSource Source)> decompiled = [];
        foreach (var name in step.Plugins)
        {
            var at = _source.FileIn(mod.SourceFolder, name);
            if (!_plugins.Exists(at)) return Refused(BuildRefusal.NotDecompiled, $"'{mod.SourceFolder}' holds no '{name}' to decompile.");
            var plugin = new RegisteredPlugin(name, mod.Name, at, provider, Line: null, PluginStrings.None);
            var read = await _decompiler.DecompileAsync(loadOrder, plugin, mod.Folder, onParsed: () => { }, CancellationToken.None, namesRepair: false);
            if (read.Source is not { } source) return Refused(BuildRefusal.NotDecompiled, read.Message);
            decompiled.Add((plugin, source));
        }

        var repository = _source.OverFolder(provider, loadOrder.GameRelease);
        SortedSet<string> replaced = new(StringComparer.Ordinal);
        foreach (var (plugin, source) in decompiled)
        {
            if (!repository.ReplaceSourceMovingAside(plugin.Key, source.Files, source.BinarySha256).Holds(out var aside, out var failure))
            {
                var why = $"The build stopped at its decompile, as {plugin.Name}'s plugin source could not be written: {failure.Reason}";
                return ItemAnswer<BuildRefusal, ModBuildOutcome>.Landed(ModBuildOutcome.Stopped(why) with { Replaced = [.. replaced] });
            }
            replaced.UnionWith(aside);
        }
        return ItemAnswer<BuildRefusal, ModBuildOutcome>.Landed(new ModBuildOutcome([], [], [], null) { Replaced = [.. replaced] });
    }

    private static IReadOnlyList<MadeFile> MadeOf(IEnumerable<(string Path, bool Vouched)> files)
    {
        Dictionary<string, bool> made = new(StringComparer.OrdinalIgnoreCase);
        foreach (var (path, vouched) in files) made[path] = vouched;
        return [.. made.Select(file => new MadeFile(file.Key, file.Value)).OrderBy(file => file.Path, StringComparer.Ordinal)];
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
    // (source.md, Build, story 7). Its source folder is the one this build reads.
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

    private async Task<(IReadOnlyList<ItemLanded<PluginAddress, IReadOnlyList<CompileDiagnostic>>> Landed, IReadOnlyList<ItemRefused<PluginAddress, CompileRefusal>> Refused)> CompileAsync(
        IReadOnlyList<RegisteredPlugin> plugins)
    {
        var twins = plugins.GroupBy(plugin => plugin.Name, StringComparer.OrdinalIgnoreCase).Where(named => named.Count() > 1).ToList();
        List<RegisteredPlugin> compilable = [.. plugins.Except(twins.SelectMany(named => named))];
        var compiled = await _compile.CompileAsync(compilable);
        return (compiled.Landed, [.. twins.SelectMany(TwinsRefused), .. compiled.Refused]);
    }

    private static IEnumerable<ItemRefused<PluginAddress, CompileRefusal>> TwinsRefused(IEnumerable<RegisteredPlugin> twins)
    {
        var named = string.Join(" and ", twins.Select(plugin => $"'{plugin.Name}'"));
        return twins.Select(plugin => new ItemRefused<PluginAddress, CompileRefusal>(plugin.Key, CompileRefusal.TwinPluginSources,
            $"{plugin.Name} cannot be compiled: the plugin sources {named} differ only in case, and one mod folder cannot hold them on Windows."));
    }

    private static BuildRefusal WholeCompileRefused(CompileRefusal refusal) => refusal switch
    {
        CompileRefusal.NoLoadOrder => BuildRefusal.NoLoadOrder,
        CompileRefusal.GitUnavailable => BuildRefusal.GitUnavailable,
        _ => throw new ArgumentOutOfRangeException(nameof(refusal), refusal, "A compile refuses a whole selection only for want of a load order or of git."),
    };

    private static ItemAnswer<BuildRefusal, ModBuildOutcome> Refused(BuildRefusal refusal, string why) =>
        ItemAnswer<BuildRefusal, ModBuildOutcome>.Refused(refusal, why);
}
