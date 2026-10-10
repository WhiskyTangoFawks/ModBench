using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Commands.Resolution;
using MEditService.LoadOrder;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Commands.Edits;

/// <summary>A placed record moving into another cell of its worldspace. A
/// cell the plugin lacks is copied in from the nearest of its masters to hold it, or created, as xEdit's Add does.</summary>
internal sealed class CellLanding(LoadOrderResolution resolution, SchemaReflector schemaReflector, ILogger logger)
{
    private sealed record Landed(RecordIdentity Cell, Func<Answer<SourceChanges, SourceFailure>>? PutCell, Answer<SourceChanges, SourceFailure> HeaderChanges);

    // A cell copied in or minted, and the header's changes a minted one needs.
    private sealed record CellIn(SourceDocument Cell, Answer<SourceChanges, SourceFailure> HeaderChanges);

    private sealed record Move(
        PluginAddress Plugin, IWriteSession Session, GameRelease Release, RecordIdentity Moved, string Worldspace,
        string CellType, string Spelled, WriteSessions Sessions)
    {
        internal ISourceRepository Repository => Session.Repository;
    }

    // One step of a landing: the value it yields, or the refusal or source failure that ends the landing.
    private abstract record Step<T>
    {
        private Step()
        {
        }

        internal abstract Step<TNext> Then<TNext>(Func<T, Step<TNext>> next);

        internal abstract Answer<RecordEditResult, SourceFailure> Finish(Func<T, Answer<RecordEditResult, SourceFailure>> last);

        internal sealed record Refused(RecordEditResult Why) : Step<T>
        {
            internal override Step<TNext> Then<TNext>(Func<T, Step<TNext>> next) => new Step<TNext>.Refused(Why);

            internal override Answer<RecordEditResult, SourceFailure> Finish(Func<T, Answer<RecordEditResult, SourceFailure>> last) => Why;
        }

        internal sealed record Stopped(SourceFailure Why) : Step<T>
        {
            internal override Step<TNext> Then<TNext>(Func<T, Step<TNext>> next) => new Step<TNext>.Stopped(Why);

            internal override Answer<RecordEditResult, SourceFailure> Finish(Func<T, Answer<RecordEditResult, SourceFailure>> last) => Why;
        }

        internal sealed record Done(T Value) : Step<T>
        {
            internal override Step<TNext> Then<TNext>(Func<T, Step<TNext>> next) => next(Value);

            internal override Answer<RecordEditResult, SourceFailure> Finish(Func<T, Answer<RecordEditResult, SourceFailure>> last) => last(Value);
        }
    }

    /// <summary>Takes <paramref name="moved"/>, the record's new text, out of the cell <paramref name="from"/> holds
    /// it in, and puts it into <paramref name="into"/>. A tree it cannot read refuses, with nothing written.</summary>
    internal RecordEditResult Land(
        PluginAddress plugin, WriteTargets.EditTarget edit, HeldIn from, SourceDocument moved, AnotherCell into, string spelled,
        WriteSessions sessions)
    {
        var failed = $"Moving {moved.FormKey} into another cell failed";
        return WriteFailure.Refused(Cross(plugin, edit, from, moved, into, spelled, sessions), refused => refused, failed, logger);
    }

    private Answer<RecordEditResult, SourceFailure> Cross(
        PluginAddress plugin, WriteTargets.EditTarget edit, HeldIn from, SourceDocument moved, AnotherCell into, string spelled,
        WriteSessions sessions)
    {
        var (release, _, session) = edit;
        var repository = edit.Repository;
        if (!repository.WorldspaceOf(plugin, from.Container.Identity).Holds(out var worldspace, out var unread)) return unread;
        if (worldspace is null)
            return CellGroupMove.Unknown(spelled, moved.FormKey, $"{plugin.Name} holds no worldspace above its cell {from.Container.FormKey}");

        var move = new Move(plugin, session, release, moved.Identity, worldspace, RecordTypes.For(release).Cell, spelled, sessions);
        var landing = into is AnotherCell.GridCell grid ? IntoGridCell(move, grid) : IntoPersistentCell(move);
        return landing.Finish(landed => RecordEditResult.Making(RecordEditResult.Success(), session, () =>
        {
            session.Apply(repository.ChangesToRemove(plugin, moved.Identity));
            if (landed.PutCell is { } putCell) session.Apply(putCell());
            session.Apply(repository.ChangesToPutChild(plugin, landed.Cell, into.Group, moved));
            session.Apply(landed.HeaderChanges);
        }));
    }

    private Step<Landed> IntoPersistentCell(Move move)
    {
        if (!move.Repository.RecordByFormKey(move.Plugin, move.Worldspace).Holds(out var held, out var unread)) return new Step<Landed>.Stopped(unread);
        if (held is not { } worldspace)
        {
            return new Step<Landed>.Refused(CellGroupMove.Unknown(
                move.Spelled, move.Moved.FormKey, $"{move.Plugin.Name} holds no document for its worldspace {move.Worldspace}"));
        }

        if (Document.Parse(worldspace.Body).DocumentAt(PlacedCell.WorldspacePersistentCellMember) is { } persistentCell)
            return new Step<Landed>.Done(new(new(GridCellHolder.FormKeyOf(persistentCell), move.CellType, null), null, SourceChanges.None));

        return CopiedOrNew(
                move,
                MastersWalkOf(move).NearestCopy(move.Worldspace, copy => copy.DocumentAt(PlacedCell.WorldspacePersistentCellMember) is not null),
                copy => Document.Parse(copy).DocumentAt(PlacedCell.WorldspacePersistentCellMember),
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
            move.Spelled, $"the cell {move.Moved.FormKey} moves into", move.Sessions);
        return holder switch
        {
            GridCellHolder.Plugins(var held) => new Step<Landed>.Done(new(held.Identity, null, SourceChanges.None)),
            GridCellHolder.Unreadable(var why) => new Step<Landed>.Refused(why),
            GridCellHolder.Masters(var copy, _) => New(copy),
            GridCellHolder.Nobody => New(new LeftCopy.None()),
            _ => throw new InvalidOperationException($"Expected HolderOfCell to answer one of its holders, not {holder.GetType().Name}."),
        };

        Step<Landed> New(LeftCopy left) =>
            CopiedOrNew(move, left, Document.Parse, 0, (grid.X, grid.Y)).Then<Landed>(copied => new Step<Landed>.Done(new(
                copied.Cell.Identity,
                () => move.Repository.ChangesToPutInWorldspace(move.Plugin, copied.Cell, move.Worldspace),
                copied.HeaderChanges)));
    }

    // xEdit's Add copies a cell in only from the plugin's masters (AllVisibleForFile; ADR-0018).
    private LoadOrderResolution.MastersWalk MastersWalkOf(Move move) =>
        resolution.WalkAmongMastersOf(move.Repository, move.Plugin, schemaReflector.GetSchemas(move.Release), move.Sessions);

    // The own fields of the nearest master's copy, as an override, or else a new cell native to the plugin.
    private Step<CellIn> CopiedOrNew(Move move, LeftCopy left, Func<string, Document?> cellIn, long flags, (int X, int Y) grid)
    {
        switch (left)
        {
            case LeftCopy.Unreadable unreadable:
                return new Step<CellIn>.Refused(unreadable.Refusal(
                    move.Spelled, $"the cell {move.Moved.FormKey} moves into is copied in from the nearest of {move.Plugin.Name}'s masters to hold it"));
            case LeftCopy.Found found:
                var copy = cellIn(found.Text)?.Text
                    ?? throw new InvalidOperationException($"The copy of a master of {move.Plugin.Name} holds no cell where it was found.");
                return new Step<CellIn>.Done(new(
                    CellOf(ContainerDocumentEdits.WithoutChildren(copy, move.Release, move.CellType), move), SourceChanges.None));
        }

        if (!FormKeyAllocator.Over(move.Repository, move.Plugin, move.Release).Holds(out var allocator, out var unread))
            return new Step<CellIn>.Stopped(unread);
        if (GridCells.Mint(
                allocator, schemaReflector.GetSchemas(move.Release)[move.CellType], move.Release, grid,
                out var minted) is { } exhausted)
            return new Step<CellIn>.Refused(exhausted with { Path = move.Spelled });
        var cell = minted ?? throw new InvalidOperationException("Expected Mint to answer a cell when it does not refuse.");
        if (flags != 0) cell = cell.With(flags, RecordHeaderFlags.Member);
        return new Step<CellIn>.Done(new(
            CellOf(RecordTextCodec.RoundTrip(cell.Text, move.Release, move.CellType), move), allocator.HeaderChanges()));
    }

    private static SourceDocument CellOf(string text, Move move) =>
        new(GridCellHolder.FormKeyOf(Document.Parse(text)), move.CellType, DocumentTokens.EditorIdIn(text).EditorId, text);
}
