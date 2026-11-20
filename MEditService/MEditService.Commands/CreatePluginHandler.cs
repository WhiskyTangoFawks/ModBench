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
    private readonly HeldWrites _held;
    private readonly PluginDecompiler _decompiler;

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every other handler.
    internal CreatePluginHandler(
        IPluginAdapter adapter, LoadOrderHolder holder, ISourceAdapter source, SchemaReflector schemaReflector, HeldWrites held,
        ILogger<CreatePluginHandler> logger) =>
        (_adapter, _holder, _source, _held, _decompiler) = (adapter, holder, source, held, new PluginDecompiler(logger, adapter, schemaReflector));

    private async Task<Answer<PluginAddress, PluginCreateRefused>> LandSourceIfCompiledPlugin(
        LoadOrderSnapshot loadOrder, PluginAddress address, string folder, string? sourceFolder, string written)
    {
        if (sourceFolder is null) return address;

        var mod = new PluginProvider.FromMod(address.Origin, folder, sourceFolder);
        var modKey = ModKey.FromFileName(address.Name);
        var plugin = RegisteredIn(address, mod);
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

    private RegisteredPlugin RegisteredIn(PluginAddress address, PluginProvider.FromMod mod) =>
        new(address.Name, address.Origin, _adapter.PathOfEmpty(ModKey.FromFileName(address.Name), mod.Folder), mod, Line: null, PluginStrings.None);

    private async Task<Answer<PluginAddress, PluginCreateRefused>> WrittenOnceItsSourceLands(
        LoadOrderSnapshot loadOrder, PluginAddress address, string folder, string? sourceFolder, string written, CancellationToken cancel)
    {
        var landed = await LandSourceIfCompiledPlugin(loadOrder, address, folder, sourceFolder, written);
        if (landed.Holds(out _, out _)) await _held.ReadBack([address], cancel);
        return landed;
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

    /// <summary>The ModKey and header flags of a new plugin named <paramref name="name"/>, or why <paramref name="release"/> takes no
    /// such plugin. <paramref name="flags"/> may be left out where one combination is offered.</summary>
    internal static Answer<(ModKey Key, IReadOnlyCollection<HeaderFlag> Flags), PluginCreateRefused> HeaderOf(
        string name, GameRelease release, IReadOnlyList<string>? flags)
    {
        if (PluginFileName.FaultOf(name, out var modKey) is not PluginFileNameFault.None and var fault)
            return new PluginCreateRefused(PluginCreateRefusal.NotAPluginFile, NotAPluginFile.Message(name, fault, release));

        if (modKey.Type == ModType.Light && !LightPluginSupport.Of(release))
            return new PluginCreateRefused(PluginCreateRefusal.LightPluginUnsupported, $"{release} has no light plugins, so {name} cannot be created.");

        if (!ChosenFlags(name, modKey, release, flags).Holds(out var chosen, out var unchosen)) return unchosen;
        return (modKey, chosen);
    }

    private static string Spelled(IEnumerable<string> flags) => $"[{string.Join(", ", flags.Select(flag => $"\"{flag}\""))}]";

    private static string SpelledAll(IEnumerable<IReadOnlyList<HeaderFlag>> combinations) =>
        string.Join(", ", CreatablePluginFlags.Names(combinations).Select(Spelled));

    private static Answer<IReadOnlyCollection<HeaderFlag>, PluginCreateRefused> ChosenFlags(
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

        var named = CreatablePluginFlags.Parse(flags);
        var match = named is null ? null : offered.FirstOrDefault(combination => named.SetEquals(combination));
        return match is null
            ? new PluginCreateRefused(PluginCreateRefusal.FlagsNotOffered,
                $"{Spelled(flags)} is not a combination of header flags offered {name}: {SpelledAll(offered)}.")
            : match.ToList();
    }

    /// <summary>Refuses, writing nothing, when no load order is held. <paramref name="sourceFolder"/> is the
    /// mod's, null for Overwrite. <paramref name="flags"/> may be left out where one combination is offered.</summary>
    public async Task<Answer<PluginAddress, PluginCreateRefused>> CreatePlugin(
        PluginAddress plugin, string folder, string? sourceFolder, IReadOnlyList<string>? flags = null, CancellationToken cancel = default)
    {
        if (_holder.Held is not { Snapshot: var loadOrder })
            return new PluginCreateRefused(PluginCreateRefusal.NoLoadOrder, NoLoadOrderException.DefaultMessage);

        var release = loadOrder.GameRelease;
        if (!HeaderOf(plugin.Name, release, flags).Holds(out var header, out var refused)) return refused;
        var (modKey, chosenFlags) = header;
        if (_source.PlacesHoldingPluginSourceOf([new PluginPlace(plugin.Origin, folder, sourceFolder)], plugin.Name).Count > 0)
        {
            return new PluginCreateRefused(
                PluginCreateRefusal.CompiledPlugin, $"'{sourceFolder}' already holds plugin source for {plugin.Name}, so it was not created.");
        }

        if (!(await _adapter.CreateAndWriteAsync(modKey, folder, release, chosenFlags)).Holds(out var created, out var failure))
            return new PluginCreateRefused(PluginCreateRefusal.WriteFailed, $"Could not write {plugin.Name} into {folder}: {failure.Reason}");

        return created switch
        {
            { Outcome: EmptyPluginWrite.Written } => await WrittenOnceItsSourceLands(loadOrder, plugin, folder, sourceFolder, created.Written, cancel),
            { Outcome: EmptyPluginWrite.FolderGone } => new PluginCreateRefused(PluginCreateRefusal.FolderGone,
                $"The folder {folder} has gone, so {plugin.Name} was not created."),
            { Outcome: EmptyPluginWrite.FileExists, Held: var held } => new PluginCreateRefused(PluginCreateRefusal.FileExists,
                $"{folder} already holds {held}, so {plugin.Name} was not created."),
            _ => throw new InvalidOperationException($"Unhandled {nameof(EmptyPluginWrite)} outcome: {created.Outcome}."),
        };
    }
}
