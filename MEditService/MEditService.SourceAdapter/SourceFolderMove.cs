namespace MEditService.SourceAdapter;

/// <summary>A source folder moved whole, as a rename of its mod moves it.</summary>
internal static class SourceFolderMove
{
    // A move within one name's case keeps its own folder, which is never in the way.
    internal static SourceChanges Changes(string from, string to, IReadOnlyList<SourceMove> files)
    {
        if (Path.Exists(to) && !string.Equals(Path.GetFullPath(from), Path.GetFullPath(to), StringComparison.OrdinalIgnoreCase))
            throw SourceStopException.Taken($"'{to}' is already there, so '{from}' was not moved.");
        var held = files.Where(file => File.Exists(Path.Combine(from, file.From))).ToList();
        if (held.FirstOrDefault(file => File.Exists(Path.Combine(from, file.To)) && !string.Equals(file.From, file.To, StringComparison.OrdinalIgnoreCase)) is { } taken)
            throw SourceStopException.Taken($"'{Path.Combine(from, taken.To)}' is already there, so '{from}' was not moved.");
        return new SourceChanges(
            [new SourceMove(from, to), .. held.Select(file => new SourceMove(Path.Combine(to, file.From), Path.Combine(to, file.To)))],
            [],
            IgnoreListFollowing(from, to, held));
    }

    private static List<DocumentChange> IgnoreListFollowing(string from, string to, List<SourceMove> held)
    {
        var path = Path.Combine(from, SourceRepositoryLayout.IgnoreListFileName);
        if (!File.Exists(path)) return [];
        var renames = held.ToDictionary(file => GitInit.Unignored(GitInit.Escaped(file.From)), file => GitInit.Unignored(GitInit.Escaped(file.To)), StringComparer.Ordinal);
        var lines = File.ReadAllText(path).Split('\n');
        var followed = lines.Select(line => line.EndsWith('\r') && renames.TryGetValue(line[..^1], out var crlf) ? crlf + "\r" : renames.GetValueOrDefault(line, line)).ToArray();
        return followed.SequenceEqual(lines) ? [] : [new DocumentChange(Path.Combine(to, SourceRepositoryLayout.IgnoreListFileName), string.Join('\n', followed))];
    }
}
