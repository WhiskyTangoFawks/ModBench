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
    // The cell document that takes the record in, the worldspace a new one goes in, and the header's
    // changes that move its Next Object ID past a cell minted for it.
    private sealed record Landed(SourceDocument Cell, string? NewInWorldspace, SourceChanges HeaderChanges);

    // A cell copied in or minted, and the header's changes a minted one needs.
    private sealed record CellIn(JsonObject Cell, SourceChanges HeaderChanges);

    private sealed record Move(
        PluginAddress Plugin, SourceRepository Repository, GameRelease Release, RecordIdentity Moved, string Worldspace,
        string CellType, string Spelled);

    // One step of a landing: the value it yields, or the refusal that ends the landing.
    private abstract record Step<T>
    {
        private Step()
        {
        }

        internal abstract Step<TNext> Then<TNext>(Func<T, Step<TNext>> next);

        internal abstract RecordEditChanges Finish(Func<T, RecordEditChanges> last);

        internal sealed record Refused(RecordEditResult Why) : Step<T>
        {
            internal override Step<TNext> Then<TNext>(Func<T, Step<TNext>> next) => new Step<TNext>.Refused(Why);

            internal override RecordEditChanges Finish(Func<T, RecordEditChanges> last) => Why;
        }

        internal sealed record Done(T Value) : Step<T>
        {
            internal override Step<TNext> Then<TNext>(Func<T, Step<TNext>> next) => next(Value);

            internal override RecordEditChanges Finish(Func<T, RecordEditChanges> last) => last(Value);
        }
    }

    /// <summary>Lands the record that <paramref name="written"/>, <paramref name="holder"/>'s new text,
    /// still carries at the crossing's prefix. A tree it cannot read refuses, with nothing written.</summary>
    internal RecordEditChanges Land(
        PluginAddress plugin, WriteTargets.EditTarget edit, RecordIdentity holder, string written, CellCrossing crossing, string spelled)
    {
        var failed = $"Moving {edit.Identity.FormKey} into another cell failed";
        return WriteFailure.Refused<RecordEditChanges>(
            () => Cross(plugin, edit, holder, written, crossing, spelled), refused => refused, failed, logger);
    }

    private RecordEditChanges Cross(
        PluginAddress plugin, WriteTargets.EditTarget edit, RecordIdentity holder, string written, CellCrossing crossing, string spelled)
    {
        var (release, moved, repository) = edit;
        var root = Parsed(written, holder.FormKey);
        var group = EmbeddedChildPath.Walk(root, [.. crossing.Prefix.Take(crossing.Prefix.Count - 1)]) as JsonArray
            ?? throw new InvalidOperationException($"{holder.FormKey}'s document has no group at {RecordEditEnvelope.Spell(crossing.Prefix)}.");
        var record = group[crossing.Prefix[^1].RequireIndex()]
            ?? throw new InvalidOperationException($"{holder.FormKey}'s document has no record at {RecordEditEnvelope.Spell(crossing.Prefix)}.");
        group.RemoveAt(crossing.Prefix[^1].RequireIndex());
        var given = Document(holder, RecordTextCodec.RoundTrip(root.ToJsonString(), release, holder.RecordType));

        var worldspace = crossing.Prefix is [{ Name: PlacedCell.WorldspacePersistentCellMember }, ..]
            ? holder.FormKey
            : repository.WorldspaceOf(plugin, holder);
        if (worldspace is null)
            return CellGroupMove.Unknown(spelled, moved.FormKey, $"{plugin.Name} holds no worldspace above its cell {holder.FormKey}");

        var move = new Move(
            plugin, repository, release, moved, worldspace,
            schemaReflector.GetSchemas(release).Keys.Single(RecordTypes.For(release).IsCell), spelled);
        var landing = crossing.Into is AnotherCell.GridCell grid ? IntoGridCell(move, grid, record) : IntoPersistentCell(move, record);
        return landing.Finish(landed => new RecordEditChanges(
            RecordEditResult.Success(),
            repository.ChangesToRewrite(plugin, given).Then(landed.NewInWorldspace is { } into
                ? repository.ChangesToPutInWorldspace(plugin, landed.Cell, into)
                : repository.ChangesToRewrite(plugin, landed.Cell)).Then(landed.HeaderChanges)));
    }

    private Step<Landed> IntoPersistentCell(Move move, JsonNode record)
    {
        if (move.Repository.Get(move.Plugin, move.Worldspace) is not { } document)
        {
            return new Step<Landed>.Refused(CellGroupMove.Unknown(
                move.Spelled, move.Moved.FormKey, $"{move.Plugin.Name} holds no document for its worldspace {move.Worldspace}"));
        }

        var worldspace = Parsed(document.Body, move.Worldspace);
        Step<CellIn> cell = worldspace[PlacedCell.WorldspacePersistentCellMember] is JsonObject held
            ? new Step<CellIn>.Done(new(held, SourceChanges.None))
            : CopiedOrNew(
                    move,
                    MastersWalkOf(move).NearestCopy(move.Worldspace, copy => copy[PlacedCell.WorldspacePersistentCellMember] is JsonObject),
                    copy => Parsed(copy, move.Worldspace)[PlacedCell.WorldspacePersistentCellMember],
                    PersistentFlag.Bit, (0, 0))
                .Then<CellIn>(copied =>
                {
                    worldspace[PlacedCell.WorldspacePersistentCellMember] = copied.Cell;
                    return new Step<CellIn>.Done(copied);
                });

        return cell.Then<Landed>(landing =>
        {
            TakeIn(landing.Cell, PersistentFlag.PersistentGroup, record);
            return new Step<Landed>.Done(new(
                Document(document.Identity, RecordTextCodec.RoundTrip(worldspace.ToJsonString(), move.Release, document.RecordType)), null,
                landing.HeaderChanges));
        });
    }

    private Step<Landed> IntoGridCell(Move move, AnotherCell.GridCell grid, JsonNode record)
    {
        var holder = resolution.HolderOfCell(
            move.Repository, move.Plugin, schemaReflector.GetSchemas(move.Release), move.Worldspace, (grid.X, grid.Y),
            move.Spelled, $"the cell {move.Moved.FormKey} moves into");
        return holder switch
        {
            GridCellHolder.Plugins(var held) => new Step<Landed>.Done(IntoHeldCell(move, held, record)),
            GridCellHolder.Unreadable(var why) => new Step<Landed>.Refused(why),
            GridCellHolder.Masters(var copy, _) => New(copy),
            GridCellHolder.Nobody => New(new LeftCopy.None()),
            _ => throw new InvalidOperationException($"Expected HolderOfCell to answer one of its holders, not {holder.GetType().Name}."),
        };

        Step<Landed> New(LeftCopy left) =>
            CopiedOrNew(move, left, copy => JsonNode.Parse(copy), 0, (grid.X, grid.Y)).Then<Landed>(landing =>
            {
                TakeIn(landing.Cell, PersistentFlag.TemporaryGroup, record);
                var text = RecordTextCodec.RoundTrip(landing.Cell.ToJsonString(), move.Release, move.CellType);
                return new Step<Landed>.Done(new(
                    new SourceDocument(GridCellHolder.FormKeyOf(landing.Cell), move.CellType, EditorIds.In(text), text),
                    move.Worldspace, landing.HeaderChanges));
            });
    }

    private static Landed IntoHeldCell(Move move, SourceDocument held, JsonNode record)
    {
        var cell = Parsed(held.Body, held.FormKey);
        TakeIn(cell, PersistentFlag.TemporaryGroup, record);
        return new(Document(held.Identity, RecordTextCodec.RoundTrip(cell.ToJsonString(), move.Release, held.RecordType)), null, SourceChanges.None);
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
                    Parsed(ContainerDocumentEdits.WithoutChildren(copy, move.Release, move.CellType), move.Worldspace),
                    SourceChanges.None));
        }

        var allocator = FormKeyAllocator.Over(move.Repository, move.Plugin, move.Release);
        if (GridCells.Mint(
                allocator, schemaReflector.GetSchemas(move.Release)[move.CellType], move.Release, grid,
                out var cell) is { } exhausted)
            return new Step<CellIn>.Refused(exhausted with { Path = move.Spelled });
        if (flags != 0) cell[RecordHeaderFlags.Member] = flags;
        return new Step<CellIn>.Done(new(cell, allocator.HeaderChanges()));
    }

    private static void TakeIn(JsonObject cell, string group, JsonNode record)
    {
        if (cell[group] is not JsonArray members) cell[group] = members = [];
        members.Add(record);
    }

    private static JsonObject Parsed(string text, string formKey) =>
        JsonNode.Parse(text) as JsonObject ?? throw new InvalidOperationException($"Expected {formKey}'s document to hold a JSON object.");

    private static SourceDocument Document(RecordIdentity identity, string text) =>
        new(identity.FormKey, identity.RecordType, EditorIds.In(text), text);
}
