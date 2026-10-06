using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using Mutagen.Bethesda;

namespace MEditService.Commands.Edits;

/// <summary>The exterior cell at a grid of a worldspace, as xEdit's Add finds it from a plugin, and a new cell minted there.</summary>
internal static class GridCells
{
    internal abstract record Holder
    {
        private Holder()
        {
        }

        /// <summary>The plugin's own cell: the one at the grid, or its copy of the master's cell there.</summary>
        internal sealed record Plugins(SourceDocument Cell) : Holder;

        /// <summary>The nearest master's cell, which the plugin holds no copy of.</summary>
        internal sealed record Masters(LeftCopy.Found Copy, string FormKey) : Holder;

        internal sealed record Nobody : Holder;

        internal sealed record Unreadable(RecordEditResult Refusal) : Holder;
    }

    /// <summary>Who holds the cell at <paramref name="grid"/>: the plugin, then its masters (xEdit's
    /// AllVisibleForFile, ADR-0018). A refusal is spelled at <paramref name="spelled"/>, naming <paramref name="subject"/>.</summary>
    internal static Holder At(
        WriteTargets targets, SourceRepository repository, PluginAddress plugin, IReadOnlyDictionary<string, RecordTableSchema> schemas,
        string worldspace, (int X, int Y) grid, string spelled, string subject)
    {
        try
        {
            if (repository.GetCellAt(plugin, worldspace, grid.X, grid.Y, schemas) is { } held) return new Holder.Plugins(held);
            if (WriteTargets.MastersOf(repository, plugin, schemas, spelled, subject, out var masters) is { } unreadable)
                return new Holder.Unreadable(unreadable);
            switch (targets.NearestCellToTheLeft(plugin, worldspace, grid.X, grid.Y, masters))
            {
                case LeftCopy.Unreadable left:
                    return new Holder.Unreadable(left.Refusal(spelled, $"{subject} is read from the nearest of {plugin.Name}'s masters"));
                case LeftCopy.Found found:
                    var formKey = FormKeyOf(JsonNode.Parse(found.Text) as JsonObject);
                    return repository.Get(plugin, formKey, schemas) is { } copy ? new Holder.Plugins(copy) : new Holder.Masters(found, formKey);
                default:
                    return new Holder.Nobody();
            }
        }
        catch (UnreadableSourceDocumentException ex)
        {
            return new Holder.Unreadable(RecordEditResult.RefusedAt(
                RecordEditRefusal.RecordParseFailed, spelled,
                $"'{spelled}': {subject} cannot be read: {ex.Message.TrimEnd('.')}. Nothing was written."));
        }
    }

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

    internal static string FormKeyOf(JsonObject? cell) =>
        cell?[RecordMembers.FormKey] is JsonValue key && key.TryGetValue<string>(out var formKey)
            ? formKey
            : throw new InvalidDataException("A cell's document names no FormKey.");
}
