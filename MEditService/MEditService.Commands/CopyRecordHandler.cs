using MEditService.Commands.Edits;
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
    private readonly ILogger<CopyRecordHandler> _logger;

    // Internal because the shared module is, which is why this assembly registers its own handlers
    // (MEditService.Commands.Composition) rather than the host naming a type it cannot see.
    internal CopyRecordHandler(
        OverrideCopy overrideCopy, NewRecordCopy newRecordCopy, LoadOrderHolder loadOrder, ILogger<CopyRecordHandler> logger) =>
        (_override, _new, _loadOrder, _logger) = (overrideCopy, newRecordCopy, loadOrder, logger);

    /// <summary>Each record lands in each destination or is refused on its own; <paramref name="replace"/>
    /// lets an override copy over the one a destination holds. Throws <see cref="NoLoadOrderException"/>
    /// with no load order held.</summary>
    public Task<SelectionResult<CopyItem, RecordEditRefusal, string?>> Copy(
        IReadOnlyList<RecordAt> records, CopyMode mode, IReadOnlyList<PluginAddress> destinations, bool replace)
    {
        _loadOrder.Require();
        return ItemWrite.Over(
            records.SelectMany(record => destinations.Select(destination => new CopyItem(record, destination))),
            SameCopy.Instance,
            item => mode == CopyMode.Override
                ? _override.Copy(item.Record.Plugin, item.Record.FormKey, item.Destination, replace)
                : _new.Copy(item.Record.Plugin, item.Record.FormKey, item.Destination),
            item => $"Could not write the copy of {item.Record.FormKey} into {item.Destination.Name} ({item.Destination.Origin})",
            _logger);
    }
}
