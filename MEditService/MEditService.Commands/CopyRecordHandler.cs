using System.ComponentModel;
using MEditService.Commands.Edits;
using MEditService.Commands.Resolution;
using MEditService.LoadOrder;
using Microsoft.Extensions.Logging;

namespace MEditService.Commands;

/// <summary>The Copy gesture's handler (ADR-0014): each record into each destination,
/// in the mode picked, as xEdit's Copy as Override Into… and Copy as New Record Into… do.</summary>
public sealed class CopyRecordHandler
{
    private readonly OverrideCopy _override;
    private readonly NewRecordCopy _new;
    private readonly LoadOrderHolder _loadOrder;
    private readonly LoadOrderResolution _resolution;
    private readonly ILogger<CopyRecordHandler> _logger;

    // Internal because the shared module is, which is why this assembly registers its own handlers
    // (MEditService.Commands.Composition) rather than the host naming a type it cannot see.
    internal CopyRecordHandler(
        OverrideCopy overrideCopy, NewRecordCopy newRecordCopy, LoadOrderHolder loadOrder, LoadOrderResolution resolution,
        ILogger<CopyRecordHandler> logger) =>
        (_override, _new, _loadOrder, _resolution, _logger) = (overrideCopy, newRecordCopy, loadOrder, resolution, logger);

    /// <summary>Each record lands in each destination or is refused on its own, after its containers.
    /// <paramref name="replace"/> lets an override copy over a held one, and refuses New.
    /// Throws <see cref="NoLoadOrderException"/> with no load order held.</summary>
    public async Task<SelectionResult<CopyItem, RecordEditRefusal, string?>> Copy(
        IReadOnlyList<RecordAt> records, CopyMode mode, IReadOnlyList<PluginAddress> destinations, bool replace)
    {
        if (replace && mode == CopyMode.New)
        {
            return SelectionResult<CopyItem, RecordEditRefusal, string?>.WholeSelectionRefused(
                RecordEditRefusal.InvalidEnvelope, "The replace Option does not apply to a copy as new.");
        }

        _loadOrder.Require();
        using var sources = new CopySources(_resolution);
        var containersFirst = records.OrderBy(record => sources.Of(record.Plugin).ContainmentDepth(record.FormKey));
        return await ItemWrite.Over(
            containersFirst.SelectMany(record => destinations.Select(destination => new CopyItem(record, destination))),
            SameCopy.Instance,
            item => mode switch
            {
                CopyMode.Override => _override.Copy(sources.Of(item.Record.Plugin), item.Record.FormKey, item.Destination, replace),
                CopyMode.New => _new.Copy(sources.Of(item.Record.Plugin), item.Record.FormKey, item.Destination),
                _ => throw new InvalidEnumArgumentException(nameof(mode), (int)mode, typeof(CopyMode)),
            },
            item => $"Could not write the copy of {item.Record.FormKey} into {item.Destination.Name} ({item.Destination.Origin})",
            _logger);
    }
}
