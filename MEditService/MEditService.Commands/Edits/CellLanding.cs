using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Commands.Resolution;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Commands.Edits;

/// <summary>A placed record moving into another cell of its worldspace. A
/// cell the plugin lacks is copied in from the nearest of its masters to hold it, or created, as xEdit's Add does.</summary>
internal sealed class CellLanding(LoadOrderResolution resolution, SchemaReflector schemaReflector, ILogger logger)
{
    // The cell that takes the record in, the put of that cell when the plugin lacks it, and the header's
    // changes that move its Next Object ID past a cell minted for it.
    private sealed record Landed(RecordIdentity Cell, Func<SourceAnswer<SourceChanges>>? PutCell, SourceAnswer<SourceChanges> HeaderChanges);

    // A cell copied in or minted, and the header's changes a minted one needs.
    private sealed record CellIn(SourceDocument Cell, SourceAnswer<SourceChanges> HeaderChanges);

    private sealed record Move(
        PluginAddress Plugin, SourceRepository Repository, GameRelease Release, RecordIdentity Moved, string Worldspace,
        string CellType, string Spelled);

    // One step of a landing: the value it yields, or the refusal or source failure that ends the landing.
    private abstract record Step<T>
    {
        private Step()
        {
        }

        internal abstract Step<TNext> Then<TNext>(Func<T, Step<TNext>> next);

        internal abstract SourceAnswer<RecordEditResult> Finish(Func<T, SourceAnswer<RecordEditResult>> last);

        internal sealed record Refused(RecordEditResult Why) : Step<T>
        {
            internal override Step<TNext> Then<TNext>(Func<T, Step<TNext>> next) => new Step<TNext>.Refused(Why);

            internal override SourceAnswer<RecordEditResult> Finish(Func<T, SourceAnswer<RecordEditResult>> last) => Why;
        }

        internal sealed record Stopped(SourceFailure Why) : Step<T>
        {
            internal override Step<TNext> Then<TNext>(Func<T, Step<TNext>> next) => new Step<TNext>.Stopped(Why);

            internal override SourceAnswer<RecordEditResult> Finish(Func<T, SourceAnswer<RecordEditResult>> last) => Why;
        }

        internal sealed record Done(T Value) : Step<T>
        {
            internal override Step<TNext> Then<TNext>(Func<T, Step<TNext>> next) => next(Value);

            internal override SourceAnswer<RecordEditResult> Finish(Func<T, SourceAnswer<RecordEditResult>> last) => last(Value);
        }
    }

    /// <summary>Takes <paramref name="moved"/>, the record's new text, out of the cell <paramref name="from"/> holds
    /// it in, and puts it into <paramref name="into"/>. A tree it cannot read refuses, with nothing written.</summary>
    internal RecordEditResult Land(
        PluginAddress plugin, WriteTargets.EditTarget edit, HeldIn from, SourceDocument moved, AnotherCell into, string spelled)
    {
        var failed = $"Moving {moved.FormKey} into another cell failed";
        return WriteFailure.Refused(Cross(plugin, edit, from, moved, into, spelled), refused => refused, failed, logger);
    }

    private SourceAnswer<RecordEditResult> Cross(
        PluginAddress plugin, WriteTargets.EditTarget edit, HeldIn from, SourceDocument moved, AnotherCell into, string spelled)
    {
        var (release, _, repository) = edit;
        if (!repository.WorldspaceOf(plugin, from.Container.Identity).Holds(out var worldspace, out var unread)) return unread;
        if (worldspace is null)
            return CellGroupMove.Unknown(spelled, moved.FormKey, $"{plugin.Name} holds no worldspace above its cell {from.Container.FormKey}");

        var move = new Move(plugin, repository, release, moved.Identity, worldspace, RecordTypes.For(release).Cell, spelled);
        var landing = into is AnotherCell.GridCell grid ? IntoGridCell(move, grid) : IntoPersistentCell(move);
        return landing.Finish(landed => RecordEditResult.Making(RecordEditResult.Success(), repository, transaction =>
        {
            transaction.Apply(repository.ChangesToRemove(plugin, moved.Identity));
            if (landed.PutCell is { } putCell) transaction.Apply(putCell());
            transaction.Apply(repository.ChangesToPutChild(plugin, landed.Cell, into.Group, moved));
            transaction.Apply(landed.HeaderChanges);
        }));
    }

    private Step<Landed> IntoPersistentCell(Move move)
    {
        if (!move.Repository.Get(move.Plugin, move.Worldspace).Holds(out var held, out var unread)) return new Step<Landed>.Stopped(unread);
        if (held is not { } worldspace)
        {
            return new Step<Landed>.Refused(CellGroupMove.Unknown(
                move.Spelled, move.Moved.FormKey, $"{move.Plugin.Name} holds no document for its worldspace {move.Worldspace}"));
        }

        if (Parsed(worldspace.Body, move.Worldspace)[PlacedCell.WorldspacePersistentCellMember] is JsonObject persistentCell)
            return new Step<Landed>.Done(new(CellOf(persistentCell.ToJsonString(), move).Identity, null, SourceChanges.None));

        return CopiedOrNew(
                move,
                MastersWalkOf(move).NearestCopy(move.Worldspace, copy => copy[PlacedCell.WorldspacePersistentCellMember] is JsonObject),
                copy => Parsed(copy, move.Worldspace)[PlacedCell.WorldspacePersistentCellMember],
                PersistentFlag.Bit, (0, 0))
            .Then<Landed>(copied => new Step<Landed>.Done(new(
                copied.Cell.Identity,
                () => move.Repository.ChangesToPutChild(
                    move.Plugin, worldspace.Identity, PlacedCell.WorldspacePersistentCellMember, copied.Cell),
                copied.HeaderChanges)));
    }

    private Step<Landed> IntoGridCell(Move move, AnotherCell.GridCell grid)
    {
        var holder = resolution.HolderOfCell(
            move.Repository, move.Plugin, schemaReflector.GetSchemas(move.Release), move.Worldspace, (grid.X, grid.Y),
            move.Spelled, $"the cell {move.Moved.FormKey} moves into");
        return holder switch
        {
            GridCellHolder.Plugins(var held) => new Step<Landed>.Done(new(held.Identity, null, SourceChanges.None)),
            GridCellHolder.Unreadable(var why) => new Step<Landed>.Refused(why),
            GridCellHolder.Masters(var copy, _) => New(copy),
            GridCellHolder.Nobody => New(new LeftCopy.None()),
            _ => throw new InvalidOperationException($"Expected HolderOfCell to answer one of its holders, not {holder.GetType().Name}."),
        };

        Step<Landed> New(LeftCopy left) =>
            CopiedOrNew(move, left, copy => JsonNode.Parse(copy), 0, (grid.X, grid.Y)).Then<Landed>(copied => new Step<Landed>.Done(new(
                copied.Cell.Identity,
                () => move.Repository.ChangesToPutInWorldspace(move.Plugin, copied.Cell, move.Worldspace),
                copied.HeaderChanges)));
    }

    // xEdit's Add copies a cell in only from the plugin's masters (AllVisibleForFile; ADR-0018).
    private LoadOrderResolution.MastersWalk MastersWalkOf(Move move) =>
        resolution.WalkAmongMastersOf(move.Repository, move.Plugin, schemaReflector.GetSchemas(move.Release));

    // The own fields of the nearest master's copy, as an override, or else a new cell native to the plugin.
    private Step<CellIn> CopiedOrNew(Move move, LeftCopy left, Func<string, JsonNode?> cellIn, long flags, (int X, int Y) grid)
    {
        switch (left)
        {
            case LeftCopy.Unreadable unreadable:
                return new Step<CellIn>.Refused(unreadable.Refusal(
                    move.Spelled, $"the cell {move.Moved.FormKey} moves into is copied in from the nearest of {move.Plugin.Name}'s masters to hold it"));
            case LeftCopy.Found found:
                var copy = cellIn(found.Text)?.ToJsonString()
                    ?? throw new InvalidOperationException($"The copy of a master of {move.Plugin.Name} holds no cell where it was found.");
                return new Step<CellIn>.Done(new(
                    CellOf(ContainerDocumentEdits.WithoutChildren(copy, move.Release, move.CellType), move), SourceChanges.None));
        }

        if (!FormKeyAllocator.Over(move.Repository, move.Plugin, move.Release).Holds(out var allocator, out var unread))
            return new Step<CellIn>.Stopped(unread);
        if (GridCells.Mint(
                allocator, schemaReflector.GetSchemas(move.Release)[move.CellType], move.Release, grid,
                out var cell) is { } exhausted)
            return new Step<CellIn>.Refused(exhausted with { Path = move.Spelled });
        if (flags != 0) cell[RecordHeaderFlags.Member] = flags;
        return new Step<CellIn>.Done(new(
            CellOf(RecordTextCodec.RoundTrip(cell.ToJsonString(), move.Release, move.CellType), move), allocator.HeaderChanges()));
    }

    private static SourceDocument CellOf(string text, Move move) =>
        new(GridCellHolder.FormKeyOf(Parsed(text, move.Worldspace)), move.CellType, EditorIds.In(text), text);

    private static JsonObject Parsed(string text, string formKey) =>
        JsonNode.Parse(text) as JsonObject ?? throw new InvalidOperationException($"Expected {formKey}'s document to hold a JSON object.");
}
