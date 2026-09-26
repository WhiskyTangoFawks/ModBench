using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;

namespace MEditService.Commands;

/// <summary>The Copy gesture's handler (ADR-0014 invariant 3): each record into each destination,
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
    public PerCopyResult Copy(
        IReadOnlyList<RecordAt> records, CopyMode mode, IReadOnlyList<PluginAddress> destinations, bool replace)
    {
        _loadOrder.Require();

        var applied = new List<CopyLanded>();
        var refused = new List<CopyRefused>();
        // A record or destination named twice is copied once: a second override would be refused as
        // already held, and a second new record would be a duplicate nobody asked for.
        var distinctDestinations = destinations.Distinct(PluginAddress.Comparer).ToList();
        foreach (var record in records.Distinct(SameRecord.Instance))
        {
            foreach (var destination in distinctDestinations)
            {
                var item = new CopyItem(record, destination);
                var result = CopyOrRefuseTheWriteFailure(item, mode, replace);
                if (result.Applied) applied.Add(new CopyLanded(item, result.NewFormKey));
                else refused.Add(new CopyRefused(item, result.Refusal, result.Message));
            }
        }
        return new PerCopyResult(applied, refused);
    }

    // A tree another tool changed, or a file system that refused the write, is this item's answer,
    // not the batch's: an exception here would hide the items already copied before it.
    private RecordEditResult CopyOrRefuseTheWriteFailure(CopyItem item, CopyMode mode, bool replace)
    {
        var ((source, formKey), destination) = (item.Record, item.Destination);
        try
        {
            return mode == CopyMode.Override
                ? _override.Copy(source, formKey, destination, replace)
                : _new.Copy(source, formKey, destination);
        }
        catch (AmbiguousSourceUnitException ex)
        {
            return RecordEditResult.Refused(RecordEditRefusal.AmbiguousSourceUnit, ex.Message);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _logger.LogError(ex, "Could not write the copy of {FormKey} into {Plugin} ({Origin})",
                formKey, destination.Name, destination.Origin);
            return RecordEditResult.Refused(
                RecordEditRefusal.SourceWriteFailed,
                $"Could not write the copy of {formKey} into {destination.Name}: {ex.Message}");
        }
    }
}
