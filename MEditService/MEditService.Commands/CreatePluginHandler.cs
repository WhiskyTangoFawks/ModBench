using MEditService.Codec.Schema;
using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands;

/// <summary>The create gesture writes the plugin file, and in a source mod its source: no init, no
/// load order change and no plugins.txt line (create-plugin). The watch hands the new file on.</summary>
public sealed class CreatePluginHandler
{
    private readonly IPluginAdapter _adapter;
    private readonly LoadOrderHolder _holder;
    private readonly ISourceAdapter _source;
    private readonly PluginDecompiler _decompiler;

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every other handler.
    internal CreatePluginHandler(
        IPluginAdapter adapter, LoadOrderHolder holder, ISourceAdapter source, SchemaReflector schemaReflector, ILogger<CreatePluginHandler> logger) =>
        (_adapter, _holder, _source, _decompiler) = (adapter, holder, source, new PluginDecompiler(logger, adapter, source, schemaReflector));

    private async Task<Answer<PluginAddress, PluginCreateRefused>> LandSourceIfCompiledPlugin(
        LoadOrderSnapshot loadOrder, PluginAddress address, string folder, string? sourceFolder, string written)
    {
        if (sourceFolder is null) return address;

        var mod = new PluginProvider.FromMod(address.Origin, folder, sourceFolder);
        var modKey = ModKey.FromFileName(address.Name);
        var plugin = new RegisteredPlugin(address.Name, address.Origin, _adapter.PathOfEmpty(modKey, folder), mod, Line: null, PluginStrings.None);
        if (!_source.IsSourceMod(plugin)) return address;

        var decompiled = await _decompiler.DecompileAsync(loadOrder, plugin, folder, onParsed: () => { }, default);
        var failure = decompiled.Source is { } source
            ? _source.OverFolder(mod, loadOrder.GameRelease)
                .ReplaceSourceFrom(address, source.Files, source.BinarySha256)?.Reason
            : decompiled.Message;
        if (failure is null) return address;

        return new PluginCreateRefused(PluginCreateRefusal.WriteFailed,
            $"Could not write {address.Name}'s source into {mod.SourceFolder}: {failure} {TakeBack(modKey, address.Name, folder, written)}");
    }

    private string TakeBack(ModKey modKey, string name, string folder, string written)
    {
        if (!_adapter.TakeBackEmpty(modKey, folder, written).Holds(out var takenBack, out var failure))
            return $"{name} could not be taken back and is still in {folder}: {failure.Reason}";
        return takenBack switch
        {
            EmptyPluginTakeBack.TakenBack or EmptyPluginTakeBack.Gone => $"{name} was not created.",
            EmptyPluginTakeBack.Changed => $"{name} was changed by something else since it was created, so it was left in {folder}.",
            var outcome => throw new InvalidOperationException($"Unhandled {nameof(EmptyPluginTakeBack)} outcome: {outcome}."),
        };
    }

    private static string Spelled(IEnumerable<string> flags) => $"[{string.Join(", ", flags.Select(flag => $"\"{flag}\""))}]";

    private static string SpelledAll(IEnumerable<IReadOnlyList<HeaderBit>> combinations) =>
        string.Join(", ", CreatablePluginFlags.Names(combinations).Select(Spelled));

    private static Answer<IReadOnlyCollection<HeaderBit>, PluginCreateRefused> ChosenFlags(
        string name, ModKey modKey, GameRelease release, IReadOnlyList<string>? flags)
    {
        var offered = CreatablePluginFlags.Of(release, modKey.Type);
        if (flags is null)
        {
            return offered.Count == 1
                ? offered[0].ToList()
                : new PluginCreateRefused(PluginCreateRefusal.FlagsNeeded,
                    $"{name} can take more than one combination of header flags, so flags must be one of: {SpelledAll(offered)}.");
        }

        var named = flags
            .Select(flag => Enum.TryParse<HeaderBit>(flag, ignoreCase: true, out var bit) ? [bit] : Array.Empty<HeaderBit>())
            .SelectMany(bit => bit).ToHashSet();
        var match = named.Count == flags.Count
            ? offered.FirstOrDefault(combination => named.SetEquals(combination))
            : null;
        return match is null
            ? new PluginCreateRefused(PluginCreateRefusal.FlagsNotOffered,
                $"{Spelled(flags)} is not a combination of header flags offered {name}: {SpelledAll(offered)}.")
            : match.ToList();
    }

    /// <summary>Refuses, writing nothing, when no load order is held. <paramref name="sourceFolder"/> is the
    /// mod's, null for Overwrite. <paramref name="flags"/> may be left out where one combination is offered.</summary>
    public async Task<Answer<PluginAddress, PluginCreateRefused>> CreatePlugin(
        PluginAddress plugin, string folder, string? sourceFolder, IReadOnlyList<string>? flags = null)
    {
        if (_holder.Held is not { Snapshot: var loadOrder })
            return new PluginCreateRefused(PluginCreateRefusal.NoLoadOrder, NoLoadOrderException.DefaultMessage);

        var release = loadOrder.GameRelease;
        if (!ModKey.TryFromFileName(plugin.Name, out var modKey))
        {
            return new PluginCreateRefused(PluginCreateRefusal.NotAPluginFile, NotAPluginFile.Message(plugin.Name, release));
        }

        if (modKey.Type == ModType.Light && !LightPluginSupport.Of(release))
        {
            return new PluginCreateRefused(PluginCreateRefusal.LightPluginUnsupported,
                $"{release} has no light plugins, so {plugin.Name} cannot be created.");
        }

        if (!ChosenFlags(plugin.Name, modKey, release, flags).Holds(out var chosenFlags, out var unchosen)) return unchosen;

        if (!(await _adapter.CreateAndWriteAsync(modKey, folder, release, chosenFlags)).Holds(out var created, out var failure))
            return new PluginCreateRefused(PluginCreateRefusal.WriteFailed, $"Could not write {plugin.Name} into {folder}: {failure.Reason}");

        return created.Outcome switch
        {
            EmptyPluginWrite.Written => await LandSourceIfCompiledPlugin(loadOrder, plugin, folder, sourceFolder, created.Written),
            EmptyPluginWrite.FolderGone => new PluginCreateRefused(PluginCreateRefusal.FolderGone,
                $"The folder {folder} has gone, so {plugin.Name} was not created."),
            EmptyPluginWrite.FileExists => new PluginCreateRefused(PluginCreateRefusal.FileExists,
                $"{folder} already holds a file named {plugin.Name}, so it was not created."),
            var outcome => throw new InvalidOperationException($"Unhandled {nameof(EmptyPluginWrite)} outcome: {outcome}."),
        };
    }
}
