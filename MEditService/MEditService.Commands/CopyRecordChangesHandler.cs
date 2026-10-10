using System.ComponentModel;
using MEditService.Commands.Edits;
using MEditService.Commands.Resolution;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;

namespace MEditService.Commands;

/// <summary>The Copy gesture's handler (ADR-0014): each record into each destination, in the mode picked,
/// as xEdit's Copy as Override Into… and Copy as New Record Into… do.</summary>
public sealed class CopyRecordChangesHandler
{
    private readonly OverrideCopy _override;
    private readonly NewRecordCopy _new;
    private readonly LoadOrderHolder _loadOrder;
    private readonly LoadOrderResolution _resolution;
    private readonly UnsavedDocuments _unsaved;
    private readonly ILogger<CopyRecordChangesHandler> _logger;

    // Internal because the shared module is, which is why this assembly registers its own handlers
    // (MEditService.Commands.Composition) rather than the host naming a type it cannot see.
    internal CopyRecordChangesHandler(
        OverrideCopy overrideCopy, NewRecordCopy newRecordCopy, LoadOrderHolder loadOrder, LoadOrderResolution resolution,
        UnsavedDocuments unsaved, ILogger<CopyRecordChangesHandler> logger) =>
        (_override, _new, _loadOrder, _resolution, _unsaved, _logger) = (overrideCopy, newRecordCopy, loadOrder, resolution, unsaved, logger);

    /// <summary>Each record's copy into each destination, containers first, answered as the changes it makes over
    /// the unsaved documents mEdit holds, written nowhere. Throws <see cref="NoLoadOrderException"/> with no load order held.</summary>
    public async Task<SelectionResult<CopyItem, RecordEditRefusal, RecordEditChanges>> CopyRecords(
        IReadOnlyList<RecordAt> records, CopyMode mode, IReadOnlyList<PluginAddress> destinations, bool replace)
    {
        if (replace && mode == CopyMode.New)
        {
            return SelectionResult<CopyItem, RecordEditRefusal, RecordEditChanges>.WholeSelectionRefused(
                RecordEditRefusal.InvalidEnvelope, "The replace Option does not apply to a copy as new.");
        }

        _loadOrder.Require();
        var sessions = new WriteSessions(_unsaved.Current);
        using var sources = new CopySources(_resolution, sessions);
        var containersFirst = records.OrderBy(record => sources.Of(record.Plugin).ContainmentDepth(record.FormKey));
        return await ItemWrite.Over(
            containersFirst.SelectMany(record => destinations.Select(destination => new CopyItem(record, destination))),
            SameCopy.Instance,
            item => mode switch
            {
                CopyMode.Override => _override.Copy(sources.Of(item.Record.Plugin), item.Record.FormKey, item.Destination, replace, sessions),
                CopyMode.New => _new.Copy(sources.Of(item.Record.Plugin), item.Record.FormKey, item.Destination, sessions),
                _ => throw new InvalidEnumArgumentException(nameof(mode), (int)mode, typeof(CopyMode)),
            },
            changes => changes,
            item => $"Could not read the source to copy {item.Record.FormKey} into {item.Destination.Name} ({item.Destination.Origin})",
            _logger);
    }
}
