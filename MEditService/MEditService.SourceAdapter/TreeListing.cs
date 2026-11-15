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

    internal void Read(string file, string? formKey)
    {
        _declared[file] = formKey;
        _gone.TryRemove(file, out _);
    }

    internal void ReadGone(string file)
    {
        _declared.TryRemove(file, out _);
        _gone[file] = true;
    }

    internal bool Holds(string file, out string? formKey) => _declared.TryGetValue(file, out formKey);

    internal bool KnowsGone(string file) => _gone.ContainsKey(file);

    internal IEnumerable<KeyValuePair<string, string?>> Files => _declared;
}
