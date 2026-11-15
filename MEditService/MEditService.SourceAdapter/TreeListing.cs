using System.Collections.Concurrent;
using MEditService.RepositoriesLib;

namespace MEditService.SourceAdapter;

/// <summary>A tree's files as its last listing found them, kept as named files are read again: the FormKey each declared,
/// none for a file that declares none, and each named file read gone since.</summary>
internal sealed class TreeListing(TimeProvider time)
{
    internal static readonly StringComparer PathComparer = StringComparer.FromComparison(FilePaths.Comparison);

    private readonly ConcurrentDictionary<string, string?> _declared = new(PathComparer);
    private readonly ConcurrentDictionary<string, bool> _gone = new(PathComparer);
    private readonly ConcurrentDictionary<string, string> _settled = new(PathComparer);

    /// <summary><paramref name="settled"/> is <see cref="SettledStampOf"/> the file, taken before the read.</summary>
    internal void Read(string file, string? formKey, string? settled = null)
    {
        _declared[file] = formKey;
        _gone.TryRemove(file, out _);
        if (settled is null) _settled.TryRemove(file, out _);
        else _settled[file] = settled;
    }

    internal void ReadGone(string file)
    {
        _declared.TryRemove(file, out _);
        _gone[file] = true;
        _settled.TryRemove(file, out _);
    }

    /// <summary>The file's stamp once it has settled, so a later write moves it (ADR-0003); null before.</summary>
    internal string? SettledStampOf(string file) => SettledStamp.Of(file, time);

    /// <summary>Whether the file keeps the settled stamp it had when last read, so it holds what was read.</summary>
    internal bool HoldsWhatWasRead(string file) => _settled.TryGetValue(file, out var stamp) && WrittenStamp.Of(file) == stamp;

    internal bool Holds(string file, out string? formKey) => _declared.TryGetValue(file, out formKey);

    internal bool KnowsGone(string file) => _gone.ContainsKey(file);

    internal IEnumerable<KeyValuePair<string, string?>> Files => _declared;
}
