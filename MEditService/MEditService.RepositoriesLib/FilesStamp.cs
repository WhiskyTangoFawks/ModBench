namespace MEditService.RepositoriesLib;

/// <summary>The <see cref="FileStamp"/>s of a set of files, taken together. Two equal stamps vouch for an
/// unchanged set only when <see cref="Vouches"/>, as one stamp alone does (ADR-0003).</summary>
public sealed class FilesStamp : IEquatable<FilesStamp>
{
    private readonly (string Path, FileStamp? Stamp)[] _stamps;

    private FilesStamp((string, FileStamp?)[] stamps, bool vouches) => (_stamps, Vouches) = (stamps, vouches);

    /// <summary>True once every file is absent or last changed long enough ago that a later write would move its stamp.</summary>
    public bool Vouches { get; }

    public static FilesStamp Of(IEnumerable<string> paths, TimeProvider timeProvider)
    {
        var taken = timeProvider.GetUtcNow();
        var stamps = paths.Select(path => (path, FileStamp.Of(path))).ToArray();
        var vouches = stamps.All(file => file.Item2 is { } stamp ? stamp.SettledAt(taken) : !File.Exists(file.path));
        return new FilesStamp(stamps, vouches);
    }

    public bool Equals(FilesStamp? other) => other is not null && _stamps.SequenceEqual(other._stamps);

    public override bool Equals(object? obj) => Equals(obj as FilesStamp);

    public override int GetHashCode() => _stamps.Length;
}
