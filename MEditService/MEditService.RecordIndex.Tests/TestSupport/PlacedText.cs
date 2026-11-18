using System.Text.RegularExpressions;
using MEditService.RecordIndex.Queries;

namespace MEditService.RecordIndex.Tests;

/// <summary>A text's places as VS Code counts them: \r\n, \r and \n each end a line.</summary>
internal static class PlacedText
{
    public static readonly Regex LineEnd = new("\r\n|\r|\n");

    public static string TextAt(string text, SourceRange range)
    {
        Assert.Equal(range.Start.Line, range.End.Line);
        return LineEnd.Split(text)[range.Start.Line][range.Start.Character..range.End.Character];
    }
}
