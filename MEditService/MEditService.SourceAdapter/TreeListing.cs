using System.Collections.Concurrent;
using MEditService.RepositoriesLib;

namespace MEditService.SourceAdapter;

/// <summary>A tree's files as its last listing found them, kept as named files are read again: the FormKey each declared,
/// none for a file that declares none, and each named file read gone since.</summary>
internal sealed class TreeListing
{
    internal static readonly StringComparer PathComparer = StringComparer.FromComparison(FilePaths.Comparison);

    private readonly ConcurrentDictionary<string, string?> _declared = new(PathComparer);
    private readonly ConcurrentDictionary<string, bool> _gone = new(PathComparer);
    private readonly ConcurrentDictionary<string, string> _written = new(PathComparer);

    /// <summary><paramref name="written"/> is the stamp of the document mEdit wrote that was read in the file's place.</summary>
    internal void Read(string file, string? formKey, string? written = null)
    {
        _declared[file] = formKey;
        _gone.TryRemove(file, out _);
        if (written is null) _written.TryRemove(file, out _);
        else _written[file] = written;
    }

    internal void ReadGone(string file)
    {
        _declared.TryRemove(file, out _);
        _gone[file] = true;
        _written.TryRemove(file, out _);
    }

    /// <summary>Whether the file still holds the document mEdit wrote there that was last read in its place.</summary>
    internal bool HoldsWhatWasWritten(string file) => _written.TryGetValue(file, out var stamp) && WrittenStamp.Of(file) == stamp;

    internal bool Holds(string file, out string? formKey) => _declared.TryGetValue(file, out formKey);

    internal bool KnowsGone(string file) => _gone.ContainsKey(file);

    internal IEnumerable<KeyValuePair<string, string?>> Files => _declared;
}
