using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.Commands.Resolution;
using MEditService.LoadOrder;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Commands;

/// <summary>The Create gesture's handler (ADR-0014): answers the changes that mint a bare record (plugins.md, Create record,
/// story 2) under the next free FormKey, written nowhere (ADR-0001).</summary>
public sealed class CreateRecordChangesHandler
{
    private readonly WriteTargets _targets;
    private readonly LoadOrderResolution _resolution;
    private readonly LoadOrderHolder _loadOrder;
    private readonly SchemaReflector _schemaReflector;
    private readonly UnsavedDocuments _unsaved;
    private readonly ILogger<CreateRecordChangesHandler> _logger;

    // Internal because the shared module is, which is why this assembly registers its own handlers
    // (MEditService.Commands.Composition) rather than the host naming a type it cannot see.
    internal CreateRecordChangesHandler(
        WriteTargets targets,
        LoadOrderResolution resolution,
        LoadOrderHolder loadOrder,
        SchemaReflector schemaReflector,
        UnsavedDocuments unsaved,
        ILogger<CreateRecordChangesHandler> logger)
    {
        (_targets, _resolution, _loadOrder, _schemaReflector, _unsaved, _logger) =
            (targets, resolution, loadOrder, schemaReflector, unsaved, logger);
    }

    /// <summary>The changes creating the record makes over the unsaved documents mEdit holds, which stand in for their
    /// files. The outcome carries the new FormKey.</summary>
    public RecordEditChanges CreateRecord(
        PluginAddress plugin, string recordType, string? container = null, GridPosition? position = null) =>
        WriteFailure.Refused(
            MintRecord(plugin, recordType, container, position), refused => refused,
            $"Could not read the source to create the new {recordType}", _logger);

    private static RecordEditResult MalformedPosition(string why) =>
        RecordEditResult.Refused(RecordEditRefusal.InvalidEnvelope, $"A grid position is for a cell in a worldspace, and the request {why}.");

    private static string AsInteriorCell(string bareCell) => PlacedCell.MarkedInterior(Document.Parse(bareCell)).Text;

    private Answer<RecordEditChanges, SourceFailure> MintRecord(PluginAddress plugin, string recordType, string? container, GridPosition? position)
    {
        if (ItemWrite.RefuseWithoutGit() is { } gitMissing) return gitMissing;
        if (_targets.RefuseUnlessEditable(plugin) is { } blocked) return blocked;
        var sessions = new WriteSessions(_unsaved.Current);
        var session = _targets.SessionOf(plugin, sessions);
        var repository = session.Repository;

        var release = _loadOrder.Current.GameRelease;
        var schemas = _schemaReflector.GetSchemas(release);
        if (recordType == PluginHeader.RecordType || !schemas.TryGetValue(recordType, out var schema))
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.RecordTypeNotFound, $"'{recordType}' is not a creatable record type.");
        }
        if (container is not null) return MintChild(session, sessions, plugin, recordType, schema, release, container, position);
        if (position is not null) return MalformedPosition("names no container");
        if (!RecordTypes.For(release).IsCreatable(recordType))
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.HeldInAnotherRecordNotYetSupported,
                $"'{recordType}' is held inside another record's document, and creating one is not supported yet.");
        }

        if (!FormKeyAllocator.Over(repository, plugin, release).Holds(out var allocator, out var unread)) return unread;
        if (allocator.Next(out var targetFormKey) is { } refusedTarget) return refusedTarget;

        var body = RecordMint.BareDocument(schema, release, targetFormKey, editorId: null);
        if (RecordTypes.For(release).IsCell(recordType)) body = AsInteriorCell(body);

        if (session.Atomically(() =>
            {
                session.Apply(repository.ChangesToPut(plugin, new SourceDocument(targetFormKey, recordType, null, body)));
                session.Apply(allocator.HeaderChanges());
            }) is { } unwritten)
        {
            return unwritten;
        }

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation(
                "Answered the creation of {RecordType} {FormKey} in {Plugin} ({Origin}) — a new source document",
                recordType, targetFormKey, plugin.Name, plugin.Origin);
        }
        return Landed(session, targetFormKey);
    }

    private static Answer<RecordEditChanges, SourceFailure> Landed(WriteSession session, string formKey) =>
        SourceAnswer.Of(new RecordEditChanges(RecordEditResult.Success(formKey), session.Changes));

    private Answer<RecordEditChanges, SourceFailure> MintChild(
        WriteSession session, WriteSessions sessions, PluginAddress plugin, string recordType, RecordTableSchema schema, GameRelease release,
        string container, GridPosition? position)
    {
        var repository = session.Repository;
        if (WriteTargets.ResolveInTheTree(plugin, container, session, release, out var target, out var containerDocument) is { } unresolved)
            return unresolved;
        if (containerDocument is null) throw new InvalidOperationException($"Expected {container}'s document to have been located.");
        var containerType = target.Identity.RecordType;
        var types = RecordTypes.For(release);
        var exteriorCell = types.IsWorldspace(containerType) && types.IsCell(recordType);
        if (position is not null && !exteriorCell) return MalformedPosition($"creates a '{recordType}' in {container}");

        var schemas = _schemaReflector.GetSchemas(release);
        CellPlace? place = null;
        if (types.IsCell(containerType))
        {
            if (!repository.CellStructureOf(plugin, target.Identity).Holds(out var cell, out var unread))
                return unread is SourceFailure.Unreadable ? WriteTargets.RefuseUnreadable(container, unread.Reason) : unread;
            place = cell?.Place;
        }

        var childSlot = ChildRecordTypes.SlotFor(containerType, containerDocument.Body, place, recordType, release);
        var containerHoldsIt = childSlot is not ChildSlot.NotHeld;
        if (exteriorCell && containerHoldsIt)
        {
            return position is { X: int x, Y: int y }
                ? CreateCellAt(session, sessions, plugin, recordType, schemas, release, container, (x, y))
                : RecordEditResult.Refused(
                    RecordEditRefusal.InvalidEnvelope, $"A cell created in the worldspace {container} takes a grid position, both x and y.");
        }
        switch (childSlot)
        {
            case ChildSlot.Open(var slot):
                return AppendChild(
                    session, plugin, recordType, schema, release, new Landing(target.Identity, Document.Parse(containerDocument.Body), slot));
            case ChildSlot.Filled(var slot, var held):
                return RecordEditResult.Refused(
                    RecordEditRefusal.ChildSlotHeldByAnotherRecord,
                    $"{container} already holds {held} as its {slot}, and holds one at most. Delete it to create another.");
            default:
                return RecordEditResult.Refused(
                    RecordEditRefusal.ContainerCannotHoldType, $"{container} cannot hold a new '{recordType}' where it sits.");
        }
    }

    private Answer<RecordEditChanges, SourceFailure> CreateCellAt(
        WriteSession session, WriteSessions sessions, PluginAddress plugin, string recordType, IReadOnlyDictionary<string, RecordTableSchema> schemas,
        GameRelease release, string worldspace, (int X, int Y) grid)
    {
        var repository = session.Repository;
        var at = $"at {grid.X}, {grid.Y}";
        var holder = _resolution.HolderOfCell(repository, plugin, schemas, worldspace, grid, worldspace, $"whether a cell sits {at}", sessions);
        switch (holder)
        {
            case GridCellHolder.Unreadable(var why):
                return why;
            case GridCellHolder.Plugins(var held):
                return RecordEditResult.Refused(
                    RecordEditRefusal.ChildSlotHeldByAnotherRecord, $"{plugin.Name} already holds the cell {held.FormKey} {at} of {worldspace}.");
            case GridCellHolder.Masters(var copy, var masterCell):
                return RecordEditResult.Refused(
                    RecordEditRefusal.ChildSlotHeldByAnotherRecord,
                    $"{copy.Plugin.Name} holds the cell {masterCell} {at} of {worldspace}. Copying the record as an override brings it into {plugin.Name}.");
            case GridCellHolder.Nobody:
                break;
            default:
                throw new InvalidOperationException($"Expected HolderOfCell to answer one of its holders, not {holder.GetType().Name}.");
        }

        if (!FormKeyAllocator.Over(repository, plugin, release).Holds(out var allocator, out var unread)) return unread;
        if (GridCells.Mint(allocator, schemas[recordType], release, grid, out var minted) is { } exhausted) return exhausted;
        var cell = minted ?? throw new InvalidOperationException("Expected Mint to answer a cell when it does not refuse.");
        var formKey = GridCellHolder.FormKeyOf(cell);
        var text = RecordTextCodec.RoundTrip(cell.Text, release, recordType);
        if (session.Atomically(() =>
            {
                session.Apply(repository.ChangesToPutInWorldspace(plugin, new SourceDocument(formKey, recordType, null, text), worldspace));
                session.Apply(allocator.HeaderChanges());
            }) is { } unwritten)
        {
            return unwritten;
        }

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation(
                "Answered the creation of cell {FormKey} in {Plugin} ({Origin}) — at grid {X}, {Y} of {Worldspace}",
                formKey, plugin.Name, plugin.Origin, grid.X, grid.Y, worldspace);
        }
        return Landed(session, formKey);
    }

    private sealed record Landing(RecordIdentity Container, Document Root, string Slot);

    private Answer<RecordEditChanges, SourceFailure> AppendChild(
        WriteSession session, PluginAddress plugin, string recordType, RecordTableSchema schema, GameRelease release,
        Landing landing)
    {
        var repository = session.Repository;
        var (container, root, slot) = landing;
        if (!FormKeyAllocator.Over(repository, plugin, release).Holds(out var allocator, out var unread)) return unread;
        if (allocator.Next(out var formKey) is { } refusedTarget) return refusedTarget;
        var bare = Document.Parse(RecordMint.BareDocument(schema, release, formKey, editorId: null));
        if (!PlacedCell.TryAsCreatedIn(bare, slot, root, release, out var child, out var unplaceable))
            return RecordEditResult.Refused(RecordEditRefusal.HeldInAnotherRecordNotYetSupported, unplaceable);
        var childDocument = new SourceDocument(formKey.ToString(), recordType, null, child.Text);

        if (session.Atomically(() =>
            {
                session.Apply(repository.ChangesToPutChild(plugin, container, slot, childDocument));
                session.Apply(allocator.HeaderChanges());
            }) is { } unwritten)
        {
            return unwritten;
        }

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation(
                "Answered the creation of {RecordType} {FormKey} in {Plugin} ({Origin}) — at the end of {Container}'s {Slot}",
                recordType, formKey, plugin.Name, plugin.Origin, container.FormKey, slot);
        }
        return Landed(session, formKey.ToString());
    }
}
