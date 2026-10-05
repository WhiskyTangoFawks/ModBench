using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Commands.Edits;

/// <summary>A placed record moving into another cell of its worldspace, through one source transaction. A
/// cell the plugin lacks is copied in from the nearest of its masters to hold it, or created, as xEdit's Add does.</summary>
internal sealed class CellLanding(WriteTargets targets, RecordTextCodec codec, SchemaReflector schemaReflector, ILogger logger)
{
    // The cell document that takes the record in, and the worldspace a new one goes in.
    private sealed record Landed(SourceDocument Cell, string? NewInWorldspace);

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

        internal abstract RecordEditResult? Finish(Func<T, RecordEditResult?> last);

        internal sealed record Refused(RecordEditResult Why) : Step<T>
        {
            internal override Step<TNext> Then<TNext>(Func<T, Step<TNext>> next) => new Step<TNext>.Refused(Why);

            internal override RecordEditResult? Finish(Func<T, RecordEditResult?> last) => Why;
        }

        internal sealed record Done(T Value) : Step<T>
        {
            internal override Step<TNext> Then<TNext>(Func<T, Step<TNext>> next) => next(Value);

            internal override RecordEditResult? Finish(Func<T, RecordEditResult?> last) => last(Value);
        }
    }

    /// <summary>Lands the record that <paramref name="written"/>, <paramref name="holder"/>'s new text,
    /// still carries at the crossing's prefix. A tree it cannot read refuses, with nothing written.</summary>
    internal RecordEditResult Land(
        PluginAddress plugin, WriteTargets.EditTarget edit, RecordIdentity holder, string written, CellCrossing crossing, string spelled,
        SourceWrite write)
    {
        var transaction = new SourceTransaction();
        return SourceCommit.Write(
                transaction, edit.Repository, logger, $"Moving {edit.Identity.FormKey} into another cell failed.",
                () => Cross(changes => write(transaction, edit.Repository, changes), plugin, edit, holder, written, crossing, spelled))
            ?? RecordEditResult.Success();
    }

    private RecordEditResult? Cross(
        Action<SourceChanges> write, PluginAddress plugin, WriteTargets.EditTarget edit, RecordIdentity holder,
        string written, CellCrossing crossing, string spelled)
    {
        var (release, moved, repository) = edit;
        var root = Parsed(written, holder.FormKey);
        var group = EmbeddedChildPath.Walk(root, [.. crossing.Prefix.Take(crossing.Prefix.Count - 1)]) as JsonArray
            ?? throw new InvalidOperationException($"{holder.FormKey}'s document has no group at {RecordEditEnvelope.Spell(crossing.Prefix)}.");
        var record = group[crossing.Prefix[^1].RequireIndex()]
            ?? throw new InvalidOperationException($"{holder.FormKey}'s document has no record at {RecordEditEnvelope.Spell(crossing.Prefix)}.");
        group.RemoveAt(crossing.Prefix[^1].RequireIndex());
        var given = Document(holder, codec.RoundTrip(root.ToJsonString(), release, holder.RecordType));

        var worldspace = crossing.Prefix is [{ Name: PlacedCell.WorldspacePersistentCellMember }, ..]
            ? holder.FormKey
            : repository.WorldspaceOf(plugin, holder);
        if (worldspace is null)
            return CellGroupMove.Unknown(spelled, moved.FormKey, $"{plugin.Name} holds no worldspace above its cell {holder.FormKey}");

        var move = new Move(
            plugin, repository, release, moved, worldspace,
            schemaReflector.GetSchemas(release).Keys.Single(RecordTypeDispatch.For(release).IsCell), spelled);
        var landing = crossing.Into is AnotherCell.GridCell grid ? IntoGridCell(move, grid, record) : IntoPersistentCell(move, record);
        return landing.Finish(landed =>
        {
            write(move.Repository.ChangesToPut(plugin, given).Then(landed.NewInWorldspace is { } into
                ? move.Repository.ChangesToPutInWorldspace(plugin, landed.Cell, into)
                : move.Repository.ChangesToPut(plugin, landed.Cell)));
            return null;
        });
    }

    private Step<Landed> IntoPersistentCell(Move move, JsonNode record)
    {
        if (move.Repository.Get(move.Plugin, move.Worldspace, schemaReflector.GetSchemas(move.Release)) is not { } document)
        {
            return new Step<Landed>.Refused(CellGroupMove.Unknown(
                move.Spelled, move.Moved.FormKey, $"{move.Plugin.Name} holds no document for its worldspace {move.Worldspace}"));
        }

        var worldspace = Parsed(document.Body, move.Worldspace);
        Step<JsonObject> cell = worldspace[PlacedCell.WorldspacePersistentCellMember] is JsonObject held
            ? new Step<JsonObject>.Done(held)
            : MastersOf(move)
                .Then(masters => CopiedOrNew(
                    move,
                    targets.NearestCopyToTheLeft(
                        move.Plugin, move.Worldspace, copy => copy[PlacedCell.WorldspacePersistentCellMember] is JsonObject,
                        among: masters),
                    copy => Parsed(copy, move.Worldspace)[PlacedCell.WorldspacePersistentCellMember],
                    PersistentFlag.Bit, (0, 0)))
                .Then<JsonObject>(copied =>
                {
                    worldspace[PlacedCell.WorldspacePersistentCellMember] = copied;
                    return new Step<JsonObject>.Done(copied);
                });

        return cell.Then<Landed>(landing =>
        {
            TakeIn(landing, PersistentFlag.PersistentGroup, record);
            return new Step<Landed>.Done(
                new(Document(document.Identity, codec.RoundTrip(worldspace.ToJsonString(), move.Release, document.RecordType)), null));
        });
    }

    private Step<Landed> IntoGridCell(Move move, AnotherCell.GridCell grid, JsonNode record)
    {
        if (move.Repository.GetCellAt(move.Plugin, move.Worldspace, grid.X, grid.Y, schemaReflector.GetSchemas(move.Release)) is { } held)
            return new Step<Landed>.Done(IntoHeldCell(move, held, record));

        return MastersOf(move).Then(masters =>
        {
            var left = targets.NearestCellToTheLeft(move.Plugin, move.Worldspace, grid.X, grid.Y, masters);
            if (left.FoundText is { } copy && FormKeyOf(Parsed(copy, move.Worldspace)) is var copied
                && move.Repository.Get(move.Plugin, copied, schemaReflector.GetSchemas(move.Release)) is { } heldCopy)
            {
                return new Step<Landed>.Done(IntoHeldCell(move, heldCopy, record));
            }

            return CopiedOrNew(move, left, copy => JsonNode.Parse(copy), 0, (grid.X, grid.Y)).Then<Landed>(cell =>
            {
                TakeIn(cell, PersistentFlag.TemporaryGroup, record);
                var text = codec.RoundTrip(cell.ToJsonString(), move.Release, move.CellType);
                return new Step<Landed>.Done(new(
                    new SourceDocument(FormKeyOf(cell), move.CellType, WriteTargets.EditorIdOf(text), text),
                    move.Worldspace));
            });
        });
    }

    private Landed IntoHeldCell(Move move, SourceDocument held, JsonNode record)
    {
        var cell = Parsed(held.Body, held.FormKey);
        TakeIn(cell, PersistentFlag.TemporaryGroup, record);
        return new(Document(held.Identity, codec.RoundTrip(cell.ToJsonString(), move.Release, held.RecordType)), null);
    }

    // xEdit's Add copies a cell in only from the plugin's masters (AllVisibleForFile; ADR-0018).
    private Step<IReadOnlySet<string>> MastersOf(Move move) =>
        WriteTargets.MastersOf(
            move.Repository, move.Plugin, schemaReflector.GetSchemas(move.Release), move.Spelled,
            $"the cell {move.Moved.FormKey} moves into", out var masters) is { } unreadable
            ? new Step<IReadOnlySet<string>>.Refused(unreadable)
            : new Step<IReadOnlySet<string>>.Done(masters);

    // The own fields of the nearest master's copy, as an override, or else a new cell native to the plugin.
    private Step<JsonObject> CopiedOrNew(Move move, LeftCopy left, Func<string, JsonNode?> cellIn, long flags, (int X, int Y) grid)
    {
        switch (left)
        {
            case LeftCopy.Unreadable unreadable:
                return new Step<JsonObject>.Refused(unreadable.Refusal(
                    move.Spelled, $"the cell {move.Moved.FormKey} moves into is copied in from the nearest of {move.Plugin.Name}'s masters to hold it"));
            case LeftCopy.Found found:
                var copy = cellIn(found.Text)?.ToJsonString()
                    ?? throw new InvalidOperationException($"The copy of a master of {move.Plugin.Name} holds no cell where it was found.");
                return new Step<JsonObject>.Done(
                    Parsed(ContainerDocumentEdits.WithoutChildren(codec, copy, move.Release, move.CellType), move.Worldspace));
        }

        if (FormKeyAllocator.Over(move.Repository, move.Plugin, move.Release).Next(out var formKey) is { } exhausted)
            return new Step<JsonObject>.Refused(exhausted with { Path = move.Spelled });
        var cell = Parsed(
            RecordMint.BareDocument(codec, schemaReflector.GetSchemas(move.Release)[move.CellType], move.Release, formKey, editorId: null),
            formKey);
        if (flags != 0) cell[RecordHeaderFlags.Member] = flags;
        cell[RecordTypeDispatch.CellGridMember] = PlacedCell.GridAt(grid.X, grid.Y);
        return new Step<JsonObject>.Done(cell);
    }

    private static void TakeIn(JsonObject cell, string group, JsonNode record)
    {
        if (cell[group] is not JsonArray members) cell[group] = members = [];
        members.Add(record);
    }

    private static string FormKeyOf(JsonObject cell) =>
        cell[RecordMembers.FormKey] is JsonValue key && key.TryGetValue<string>(out var formKey)
            ? formKey
            : throw new InvalidDataException("A cell's document names no FormKey.");

    private static JsonObject Parsed(string text, string formKey) =>
        JsonNode.Parse(text) as JsonObject ?? throw new InvalidOperationException($"Expected {formKey}'s document to hold a JSON object.");

    private static SourceDocument Document(RecordIdentity identity, string text) =>
        new(identity.FormKey, identity.RecordType, WriteTargets.EditorIdOf(text), text);
}
