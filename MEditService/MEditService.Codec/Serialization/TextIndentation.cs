namespace MEditService.Codec.Serialization;

/// <summary>A document's text moved between columns. The first line keeps its place: it continues the line it is
/// spliced into.</summary>
internal static class TextIndentation
{
    /// <summary>The column the line holding <paramref name="at"/> starts its text at.</summary>
    public static int ColumnAt(byte[] bytes, int at)
    {
        var lineStart = at;
        while (lineStart > 0 && bytes[lineStart - 1] != (byte)'\n') lineStart--;

        var spaces = 0;
        while (lineStart + spaces < at && bytes[lineStart + spaces] == (byte)' ') spaces++;
        return spaces;
    }

    public static string Outdented(string text, int columns) =>
        columns == 0
            ? text
            : string.Join('\n', text.Split('\n').Select((line, at) => at == 0 ? line : WithoutLeadingSpaces(line, columns)));

    public static string Indented(string text, int columns) =>
        columns == 0
            ? text
            : string.Join('\n', text.Split('\n').Select((line, at) => at == 0 || line.Length == 0 ? line : new string(' ', columns) + line));

    private static string WithoutLeadingSpaces(string line, int spaces)
    {
        var at = 0;
        while (at < spaces && at < line.Length && line[at] == ' ') at++;
        return line[at..];
    }
}
