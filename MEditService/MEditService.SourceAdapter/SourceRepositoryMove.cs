using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using Mutagen.Bethesda.Plugins;

namespace MEditService.SourceAdapter;

/// <summary>The full, absolute path a container's subtree moved from and to — what a transaction
/// needs to log the move without computing either path itself. A caller reporting one relativises it
/// to a mod folder.</summary>
internal readonly record struct MovedContainer(string From, string To);

/// <summary>Moves a directory-per-record container to the leaf its new identity computes, subtree and
/// all.</summary>
public sealed partial class SourceRepository
{
    /// <summary>Moves the container <paramref name="identity"/> names to the leaf
    /// <paramref name="newFormKey"/> computes, keeping its EditorID. Null when nothing moved. Refuses
    /// before touching the tree when that leaf is already occupied.</summary>
    internal MovedContainer? Move(PluginAddress plugin, RecordIdentity identity, string newFormKey)
    {
        if (Locate(plugin, identity) is not { IsEmbedded: false, IsDirectoryPerRecord: true } unit) return null;

        var from = PathShape.DirectoryOf(unit.FullPath);
        var to = Path.Combine(
            PathShape.DirectoryOf(from),
            LeafNameFor(FormKey.Factory(newFormKey), identity.EditorId, isDirectory: true));
        if (string.Equals(from, to, StringComparison.Ordinal)) return null;

        if (Directory.Exists(to) || File.Exists(to))
        {
            throw new IOException(
                $"{Path.GetFileName(to)} already exists in {Path.GetDirectoryName(to)}, so the container whose FormID changed " +
                "has nowhere to move to.");
        }

        Directory.Move(from, to);
        Forget();
        return new MovedContainer(from, to);
    }
}
