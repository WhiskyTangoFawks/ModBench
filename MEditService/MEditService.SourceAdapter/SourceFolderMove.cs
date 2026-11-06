namespace MEditService.SourceAdapter;

/// <summary>A source folder moved whole, as a rename of its mod moves it.</summary>
internal static class SourceFolderMove
{
    // A move within one name's case keeps its own folder, which is never in the way.
    internal static SourceChanges? Changes(string from, string to, IReadOnlyList<SourceMove> files)
    {
        if (Path.Exists(to) && !string.Equals(Path.GetFullPath(from), Path.GetFullPath(to), StringComparison.OrdinalIgnoreCase)) return null;
        var held = files.Where(file => File.Exists(Path.Combine(from, file.From))).ToList();
        if (held.Any(file => File.Exists(Path.Combine(from, file.To)) && !string.Equals(file.From, file.To, StringComparison.OrdinalIgnoreCase))) return null;
        return new SourceChanges([new SourceMove(from, to), .. held.Select(file => new SourceMove(Path.Combine(to, file.From), Path.Combine(to, file.To)))], [], []);
    }
}
