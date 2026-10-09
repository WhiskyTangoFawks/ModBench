using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.SourceAdapter;

namespace MEditService.Commands.Resolution;

/// <summary>Who holds the exterior cell at a grid of a worldspace, as xEdit's Add finds it from a plugin.</summary>
internal abstract record GridCellHolder
{
    private GridCellHolder()
    {
    }

    /// <summary>The plugin's own cell: the one at the grid, or its copy of the master's cell there.</summary>
    internal sealed record Plugins(SourceDocument Cell) : GridCellHolder;

    /// <summary>The nearest master's cell, which the plugin holds no copy of.</summary>
    internal sealed record Masters(LeftCopy.Found Copy, string FormKey) : GridCellHolder;

    internal sealed record Nobody : GridCellHolder;

    internal sealed record Unreadable(RecordEditResult Refusal) : GridCellHolder;

    internal static string FormKeyOf(Document cell) =>
        cell.StringAt(RecordMembers.FormKey) ?? throw new InvalidDataException("A cell's document names no FormKey.");
}
