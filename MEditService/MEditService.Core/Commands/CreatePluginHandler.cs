using MEditService.Core.PluginAdapter;
using MEditService.Core.Plugins;
using MEditService.Core.Source;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Core.Commands;

/// <summary>ADR-0007's create gesture: the plugin file, and the Track its destination needs before
/// anything can be edited there. The endpoint registers the copy before this runs. Never touches
/// plugins.txt.</summary>
public sealed class CreatePluginHandler
{
    private readonly TrackHandler _track;

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every other handler.
    internal CreatePluginHandler(TrackHandler track) => _track = track;

    /// <summary>Asynchronous because Track is: the destination is tracked in this same gesture, so a
    /// created plugin is editable the moment it exists. <paramref name="loadOrder"/> already
    /// registers <paramref name="copy"/>.</summary>
    public async Task<PluginCreateResult> CreatePlugin(
        LoadOrder loadOrder, RegisteredCopy copy, IReadOnlyCollection<PluginKey> heldCopies)
    {
        // A new plugin defaults to an ESL-flagged ESP, silently; the flag is an ordinary editable
        // header field afterward. An explicit .esl is already light, an explicit .esm asked for a
        // full master.
        var modKey = ModKey.FromFileName(copy.Name);
        await MutagenPluginAdapter.Instance.CreateAndWriteAsync(
            modKey, copy.Path, loadOrder.GameRelease, smallMaster: modKey.Type == ModType.Plugin);

        var modFolder = ModFolders.Of(copy.Origin, copy.Path);
        if (modFolder is null || SourceRepository.IsTracked(modFolder)) return new PluginCreateResult(null);

        // Held by construction: this gesture wrote the file, so Track's own "which copies are
        // readable" filter must count it alongside whatever the Index already holds.
        var track = await _track.TrackAsync(
            loadOrder, [.. heldCopies, copy.Key], copy.Origin, SourcePreset.Edits);
        return new PluginCreateResult(track);
    }
}
