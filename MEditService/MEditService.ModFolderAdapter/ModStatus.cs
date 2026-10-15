using System.Text.Json.Serialization;

namespace MEditService.ModFolderAdapter;

/// <summary>A mod folder against its manifest (modlist-source.md, Status), each list by path on disk in ordinal order.
/// Differing holds each file whose bytes the stat cache cannot vouch are its provider's.
/// MetadataDiffers is whether the manifest's metadata replaces a value the mod manager's holds, and ManifestMetadata what the
/// manifest says of it, none without a manifest.</summary>
public sealed record ModStatus(
    string Mod, bool NoManifest, IReadOnlyList<string> Differing, IReadOnlyList<string> NamedByNoLine, IReadOnlyList<string> Gone,
    IReadOnlyList<string> NoProvider, ModUnreadable? Unreadable = null, string? StatCacheNotWritten = null,
    bool MetadataDiffers = false, [property: JsonIgnore] ModMetadata? ManifestMetadata = null)
{
    public bool Equals(ModStatus? other) =>
        other is not null && Mod == other.Mod && NoManifest == other.NoManifest && Unreadable == other.Unreadable
        && StatCacheNotWritten == other.StatCacheNotWritten && MetadataDiffers == other.MetadataDiffers
        && Differing.SequenceEqual(other.Differing) && NamedByNoLine.SequenceEqual(other.NamedByNoLine)
        && Gone.SequenceEqual(other.Gone) && NoProvider.SequenceEqual(other.NoProvider);

    public override int GetHashCode() => HashCode.Combine(Mod, NoManifest, Unreadable, Differing.Count, NamedByNoLine.Count, Gone.Count, NoProvider.Count, MetadataDiffers);
}

/// <summary>Why a mod's status could not be read, its manifest or else one of its files, so it lists nothing.</summary>
public sealed record ModUnreadable(bool Manifest, string Why);
