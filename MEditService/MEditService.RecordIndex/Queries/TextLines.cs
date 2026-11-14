namespace MEditService.RecordIndex.Queries;

/// <summary>A text's places as VS Code counts them: \r\n, \r and \n each end a line.</summary>
internal sealed class TextLines
{
    private readonly List<int> _starts = [0];

    public TextLines(string text)
    {
        for (var i = 0; i < text.Length; i++)
        {
            if (text[i] == '\n' || (text[i] == '\r' && (i + 1 == text.Length || text[i + 1] != '\n'))) _starts.Add(i + 1);
        }
    }

    public SourceRange RangeOf(int start, int end) => new(PositionAt(start), PositionAt(end));

    private SourcePosition PositionAt(int offset)
    {
        var found = _starts.BinarySearch(offset);
        var line = found >= 0 ? found : ~found - 1;
        return new(line, offset - _starts[line]);
    }
}
