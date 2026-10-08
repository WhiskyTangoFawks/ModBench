using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using Mutagen.Bethesda;

namespace MEditService.Commands.Edits;

/// <summary>A new exterior cell minted at a grid of a worldspace.</summary>
internal static class GridCells
{
    /// <summary>A bare cell under the plugin's next free FormKey, at <paramref name="grid"/>.</summary>
    internal static RecordEditResult? Mint(
        SourceRepository repository, PluginAddress plugin, RecordTextCodec codec, RecordTableSchema schema, GameRelease release,
        (int X, int Y) grid, out JsonObject cell)
    {
        cell = [];
        if (FormKeyAllocator.Over(repository, plugin, release).Next(out var formKey) is { } exhausted) return exhausted;
        cell = JsonNode.Parse(RecordMint.BareDocument(codec, schema, release, formKey, editorId: null)) as JsonObject
            ?? throw new InvalidOperationException($"Expected the minted cell {formKey}'s document to hold a JSON object.");
        cell[RecordTypeDispatch.CellGridMember] = PlacedCell.GridAt(grid.X, grid.Y);
        return null;
    }
}
