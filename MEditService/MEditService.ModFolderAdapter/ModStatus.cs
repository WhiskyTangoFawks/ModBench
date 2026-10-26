using System.Text.Json.Serialization;

namespace MEditService.ModFolderAdapter;

/// <summary>A mod folder against its manifest (modlist-repository.md, Status), each list by path on disk in ordinal order.
/// Differing holds each file whose bytes the stat cache cannot vouch are its package's.</summary>
public sealed record ModStatus(
    string Mod, bool NoManifest, IReadOnlyList<string> Differing, IReadOnlyList<string> NamedByNoLine, IReadOnlyList<string> Gone,
    IReadOnlyList<string> NotInPackage, IReadOnlyList<string> OtherBytes, ModUnreadable? Unreadable = null, string? StatCacheNotWritten = null,
    bool MetadataDiffers = false, [property: JsonIgnore] ModMetadata? ManifestMetadata = null, bool NoHost = false)
{
    public bool Equals(ModStatus? other) =>
        other is not null && Mod == other.Mod && NoManifest == other.NoManifest && Unreadable == other.Unreadable
        && StatCacheNotWritten == other.StatCacheNotWritten && MetadataDiffers == other.MetadataDiffers && NoHost == other.NoHost
        && Differing.SequenceEqual(other.Differing) && NamedByNoLine.SequenceEqual(other.NamedByNoLine)
        && Gone.SequenceEqual(other.Gone) && NotInPackage.SequenceEqual(other.NotInPackage) && OtherBytes.SequenceEqual(other.OtherBytes);

    public override int GetHashCode() => HashCode.Combine(Mod, NoManifest, Unreadable, Differing.Count, NamedByNoLine.Count, Gone.Count, NotInPackage.Count, MetadataDiffers);
}

/// <summary>Why a mod's status could not be read, its manifest or else its metadata or one of its files, so it lists nothing.</summary>
public sealed record ModUnreadable(bool Manifest, string Why);
