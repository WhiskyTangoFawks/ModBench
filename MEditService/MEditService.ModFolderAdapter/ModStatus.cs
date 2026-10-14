namespace MEditService.ModFolderAdapter;

/// <summary>A mod folder against its manifest (modlist-source.md, Status), each list by path in ordinal order. Differing
/// holds each file whose bytes the stat cache cannot vouch are its provider's. An unreadable mod lists nothing.</summary>
public sealed record ModStatus(
    string Mod, bool NoManifest, IReadOnlyList<string> Differing, IReadOnlyList<string> NamedByNoLine, IReadOnlyList<string> Gone,
    IReadOnlyList<string> NoProvider, string? Unreadable = null)
{
    public bool Equals(ModStatus? other) =>
        other is not null && Mod == other.Mod && NoManifest == other.NoManifest && Unreadable == other.Unreadable
        && Differing.SequenceEqual(other.Differing) && NamedByNoLine.SequenceEqual(other.NamedByNoLine)
        && Gone.SequenceEqual(other.Gone) && NoProvider.SequenceEqual(other.NoProvider);

    public override int GetHashCode() => HashCode.Combine(Mod, NoManifest, Unreadable, Differing.Count, NamedByNoLine.Count, Gone.Count, NoProvider.Count);
}
