using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda;

namespace MEditService.Commands.Edits;

/// <summary>A new exterior cell minted at a grid of a worldspace.</summary>
internal static class GridCells
{
    /// <summary>A bare cell under the FormKey <paramref name="allocator"/> draws next, at <paramref name="grid"/>.</summary>
    internal static RecordEditResult? Mint(
        FormKeyAllocator allocator, RecordTableSchema schema, GameRelease release,
        (int X, int Y) grid, out Document? cell)
    {
        cell = null;
        if (allocator.Next(out var formKey) is { } exhausted) return exhausted;
        cell = PlacedCell.WithGrid(Document.Parse(RecordMint.BareDocument(schema, release, formKey, editorId: null)), grid.X, grid.Y);
        return null;
    }
}
