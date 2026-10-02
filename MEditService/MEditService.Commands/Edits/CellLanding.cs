using System.Globalization;
using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Commands.Edits;

/// <summary>A placed record moving into another cell of its worldspace, through one source transaction. A
/// cell the plugin lacks is copied in from its nearest copy to the left, or created, as xEdit's Add does.</summary>
internal sealed class CellLanding(WriteTargets targets, RecordTextCodec codec, SchemaReflector schemaReflector, ILogger logger)
{
    private const string GridPointMember = "Point";

    // The cell document that takes the record in, and where a new one goes.
    private sealed record Landed(SourceDocument Cell, CellPlacement? Placement);

    private sealed record Move(
        PluginAddress Plugin, SourceRepository Repository, GameRelease Release, RecordIdentity Moved, string Worldspace,
        string CellType, string Spelled);

    /// <summary>Lands the record that <paramref name="written"/>, <paramref name="holder"/>'s new text,
    /// still carries at the crossing's prefix. A tree it cannot read refuses, with nothing written.</summary>
    internal RecordEditResult Land(
        PluginAddress plugin, WriteTargets.EditTarget edit, RecordIdentity holder, string written, CellCrossing crossing, string spelled)
    {
        var transaction = new SourceRepository.SourceTransaction();
        return SourceCommit.Write(
                transaction, edit.Repository, logger, $"Moving {edit.Identity.FormKey} into another cell failed.",
                () => Cross(transaction, plugin, edit, holder, written, crossing, spelled))
            ?? RecordEditResult.Success();
    }

    private RecordEditResult? Cross(
        SourceRepository.SourceTransaction transaction, PluginAddress plugin, WriteTargets.EditTarget edit, RecordIdentity holder,
        string written, CellCrossing crossing, string spelled)
    {
        var (release, moved, _, repository) = edit;
        var root = Parsed(written, holder.FormKey);
        var group = EmbeddedChildPath.Walk(root, [.. crossing.Prefix.Take(crossing.Prefix.Count - 1)]) as JsonArray
            ?? throw new InvalidOperationException($"{holder.FormKey}'s document has no group at {RecordEditEnvelope.Spell(crossing.Prefix)}.");
        var record = group[crossing.Prefix[^1].RequireIndex()]
            ?? throw new InvalidOperationException($"{holder.FormKey}'s document has no record at {RecordEditEnvelope.Spell(crossing.Prefix)}.");
        group.RemoveAt(crossing.Prefix[^1].RequireIndex());
        var given = Document(holder, codec.RoundTrip(root.ToJsonString(), release, holder.RecordType));

        var worldspace = crossing.Prefix is [{ Name: PlacedCell.WorldspacePersistentCellMember }, ..]
            ? holder.FormKey
            : repository.CellPlacementOf(plugin, holder)?.ParentWorldspace;
        if (worldspace is null) return Unknown(spelled, moved.FormKey, $"{plugin.Name} holds no worldspace above its cell {holder.FormKey}");

        var move = new Move(
            plugin, repository, release, moved, worldspace,
            schemaReflector.GetSchemas(release).Keys.Single(RecordTypeDispatch.For(release).IsCell), spelled);
        return crossing.Into switch
        {
            AnotherCell.GridCell grid => IntoGridCell(move, grid, record, out var landed) ?? Write(transaction, move, given, landed),
            _ => IntoPersistentCell(move, record, out var landed) ?? Write(transaction, move, given, landed),
        };
    }

    private RecordEditResult? Write(SourceRepository.SourceTransaction transaction, Move move, SourceDocument given, Landed? landed)
    {
        var into = landed ?? throw new InvalidOperationException("Expected a cell to land in when nothing refused.");
        transaction.Put(move.Repository, move.Plugin, given);
        if (into.Placement is { } placement) transaction.Put(move.Repository, move.Plugin, into.Cell, placement);
        else transaction.Put(move.Repository, move.Plugin, into.Cell);

        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "Moved {FormKey} out of {Holder} into {Cell} in {Plugin} ({Origin}), as its Persistent changed",
                move.Moved.FormKey, given.FormKey, into.Cell.FormKey, move.Plugin.Name, move.Plugin.Origin);
        }
        return null;
    }

    // The worldspace's own persistent cell, inside its document.
    private RecordEditResult? IntoPersistentCell(Move move, JsonNode record, out Landed? landed)
    {
        landed = null;
        if (move.Repository.IdentityOf(move.Plugin, move.Worldspace, schemaReflector.GetSchemas(move.Release)) is not { } identity
            || move.Repository.Get(move.Plugin, identity) is not { } document)
        {
            return Unknown(move.Spelled, move.Moved.FormKey, $"{move.Plugin.Name} holds no document for its worldspace {move.Worldspace}");
        }

        var worldspace = Parsed(document.Body, move.Worldspace);
        if (worldspace[PlacedCell.WorldspacePersistentCellMember] is not JsonObject cell)
        {
            var left = targets.NearestCopyToTheLeft(
                move.Plugin, move.Worldspace, copy => copy[PlacedCell.WorldspacePersistentCellMember] is JsonObject);
            if (FromTheLeft(move, left, copy => Parsed(copy, move.Worldspace)[PlacedCell.WorldspacePersistentCellMember], out var copied) is { } refused)
                return refused;
            if (copied == null && New(move, PersistentFlag.Bit, (0, 0), out copied) is { } exhausted) return exhausted;
            cell = copied ?? throw new InvalidOperationException("Expected a persistent cell copied in or created.");
            worldspace[PlacedCell.WorldspacePersistentCellMember] = cell;
        }

        TakeIn(cell, PersistentFlag.PersistentGroup, record);
        landed = new(Document(identity, codec.RoundTrip(worldspace.ToJsonString(), move.Release, identity.RecordType)), null);
        return null;
    }

    // The worldspace's cell at the grid, a document of its own under its block and sub-block.
    private RecordEditResult? IntoGridCell(Move move, AnotherCell.GridCell grid, JsonNode record, out Landed? landed)
    {
        landed = null;
        var schemas = schemaReflector.GetSchemas(move.Release);
        if (move.Repository.CellAt(move.Plugin, move.Worldspace, grid.X, grid.Y) is { } held)
            return IntoHeldCell(move, held, record, out landed);

        var left = targets.NearestCellToTheLeft(move.Plugin, move.Worldspace, grid.X, grid.Y);
        if (FromTheLeft(move, left, copy => JsonNode.Parse(copy), out var cell) is { } refused) return refused;
        if (cell?[RecordMembers.FormKey]?.GetValue<string>() is { } copied
            && move.Repository.IdentityOf(move.Plugin, copied, schemas) is not null)
        {
            return IntoHeldCell(move, copied, record, out landed);
        }
        if (cell == null && New(move, 0, (grid.X, grid.Y), out cell) is { } exhausted) return exhausted;
        var landing = cell ?? throw new InvalidOperationException("Expected a grid cell copied in or created.");

        TakeIn(landing, PersistentFlag.TemporaryGroup, record);
        var text = codec.RoundTrip(landing.ToJsonString(), move.Release, move.CellType);
        var formKey = landing[RecordMembers.FormKey]?.GetValue<string>()
            ?? throw new InvalidOperationException("Expected the cell landing the record to name its FormKey.");
        landed = new(
            new SourceDocument(formKey, move.CellType, WriteTargets.EditorIdOf(text), text),
            CellPlacement.AtGrid(move.Worldspace, grid.X, grid.Y));
        return null;
    }

    private RecordEditResult? IntoHeldCell(Move move, string formKey, JsonNode record, out Landed? landed)
    {
        var identity = move.Repository.IdentityOf(move.Plugin, formKey, schemaReflector.GetSchemas(move.Release))
            ?? throw new InvalidOperationException($"{move.Plugin.Name} named {formKey} as the cell at a grid, but holds no record under it.");
        var document = move.Repository.Get(move.Plugin, identity)
            ?? throw new InvalidOperationException($"{move.Plugin.Name} holds {formKey}, but no document in its source tree carries it.");
        var cell = Parsed(document.Body, formKey);
        TakeIn(cell, PersistentFlag.TemporaryGroup, record);
        landed = new(Document(identity, codec.RoundTrip(cell.ToJsonString(), move.Release, identity.RecordType)), null);
        return null;
    }

    // The own fields of the nearest copy to the left, as an override: its children stay where they are.
    private RecordEditResult? FromTheLeft(Move move, LeftCopy left, Func<string, JsonNode?> cellIn, out JsonObject? cell)
    {
        cell = null;
        if (left is LeftCopy.Unreadable unreadable)
            return unreadable.Refusal(move.Spelled, $"the cell {move.Moved.FormKey} moves into is copied in from its nearest copy to the left");
        if (left.FoundText is not { } text) return null;
        var copy = cellIn(text)?.ToJsonString()
            ?? throw new InvalidOperationException($"The copy to the left of {move.Plugin.Name} holds no cell where it was found.");
        cell = Parsed(ContainerDocumentEdits.WithoutChildren(codec, copy, move.Release, move.CellType), move.Worldspace);
        return null;
    }

    // A cell no copy holds: a new record native to the plugin at the grid, as xEdit's Add makes it.
    private RecordEditResult? New(Move move, long flags, (int X, int Y) grid, out JsonObject? cell)
    {
        cell = null;
        if (targets.ResolveTargetFormKey(move.Repository, move.Plugin, null, out var formKey) is { } exhausted)
            return exhausted with { Path = move.Spelled };
        cell = Parsed(
            RecordMint.BareDocument(codec, schemaReflector.GetSchemas(move.Release)[move.CellType], move.Release, formKey, editorId: null, partialForm: false),
            formKey);
        if (flags != 0) cell[RecordHeaderFlags.Member] = flags;
        cell[RecordTypeDispatch.CellGridMember] = grid == (0, 0)
            ? new JsonObject()
            : new JsonObject { [GridPointMember] = string.Create(CultureInfo.InvariantCulture, $"{grid.X}, {grid.Y}") };
        return null;
    }

    private static void TakeIn(JsonObject cell, string group, JsonNode record)
    {
        if (cell[group] is not JsonArray members) cell[group] = members = [];
        members.Add(record);
    }

    private static JsonObject Parsed(string text, string formKey) =>
        JsonNode.Parse(text) as JsonObject ?? throw new InvalidOperationException($"Expected {formKey}'s document to hold a JSON object.");

    private static SourceDocument Document(RecordIdentity identity, string text) =>
        new(identity.FormKey, identity.RecordType, WriteTargets.EditorIdOf(text), text);

    private static RecordEditResult Unknown(string spelled, string formKey, string why) =>
        RecordEditResult.RefusedAt(
            RecordEditRefusal.PersistentMoveDestinationUnknown, spelled,
            $"Which cell xEdit would move {formKey} into is unknown: {why}. Nothing was written.");
}
