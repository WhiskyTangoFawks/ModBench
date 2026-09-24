using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;

namespace MEditService.Commands;

/// <summary>The Delete gesture's handler (ADR-0014 invariant 3): a working-tree deletion, gone at
/// Effective, still served at Head until compiled. No reference cascade — a dangling FormLink
/// surfaces as an ordinary compile diagnostic (ADR-0007).</summary>
public sealed class DeleteRecordHandler
{
    private readonly WriteTargets _targets;
    private readonly LoadOrderHolder _loadOrder;
    private readonly ILogger<DeleteRecordHandler> _logger;

    // Internal because the shared module is, which is why this assembly registers its own handlers
    // (MEditService.Commands.Composition) rather than the host naming a type it cannot see.
    internal DeleteRecordHandler(WriteTargets targets, LoadOrderHolder loadOrder, ILogger<DeleteRecordHandler> logger) =>
        (_targets, _loadOrder, _logger) = (targets, loadOrder, logger);

    /// <summary>Each record is deleted or refused on its own; git missing refuses the whole selection
    /// once, before any record. Throws <see cref="NoLoadOrderException"/> when no load order is held
    /// (ADR-0013 invariant 4).</summary>
    public PerRecordResult DeleteRecords(IReadOnlyList<RecordAt> records)
    {
        _loadOrder.Require();
        try
        {
            SourceRepository.EnsureTrackable();
        }
        catch (GitUnavailableException ex)
        {
            return PerRecordResult.WholeSelectionRefused(RecordEditRefusal.GitUnavailable, ex.Message);
        }

        var applied = new List<RecordAt>();
        var refused = new List<RecordRefused>();
        var seen = new HashSet<RecordAt>(SameRecord.Instance);
        foreach (var record in records)
        {
            // A record named twice is deleted once: its second delete would find nothing and be
            // reported as refused, for a record that is gone.
            if (!seen.Add(record)) continue;
            var result = DeleteOrRefuseTheWriteFailure(record);
            if (result.Applied) applied.Add(record);
            else refused.Add(new RecordRefused(record, result.Refusal, result.Message));
        }
        return new PerRecordResult(applied, refused);
    }

    // A tree another tool changed, or a file system that refused the write, is this record's answer,
    // not the batch's: an exception here would hide the records already deleted before it.
    private RecordEditResult DeleteOrRefuseTheWriteFailure(RecordAt record)
    {
        try
        {
            return Delete(record.Plugin, record.FormKey);
        }
        catch (AmbiguousSourceUnitException ex)
        {
            return RecordEditResult.Refused(RecordEditRefusal.AmbiguousSourceUnit, ex.Message);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _logger.LogError(ex, "Could not delete the source file for {FormKey} in {Plugin} ({Origin})",
                record.FormKey, record.Plugin.Name, record.Plugin.Origin);
            return RecordEditResult.Refused(
                RecordEditRefusal.SourceWriteFailed,
                $"Could not delete the source file for {record.FormKey}: {ex.Message}");
        }
    }

    // The plugin compares as every other lookup on it does, and a FormKey's mod name is a filename.
    private sealed class SameRecord : IEqualityComparer<RecordAt>
    {
        internal static readonly SameRecord Instance = new();

        public bool Equals(RecordAt x, RecordAt y) =>
            PluginCopyKey.Comparer.Equals(x.Plugin, y.Plugin)
            && string.Equals(x.FormKey, y.FormKey, StringComparison.OrdinalIgnoreCase);

        public int GetHashCode(RecordAt record) => HashCode.Combine(
            PluginCopyKey.Comparer.GetHashCode(record.Plugin),
            StringComparer.OrdinalIgnoreCase.GetHashCode(record.FormKey));
    }

    private RecordEditResult Delete(PluginCopyKey plugin, string formKey)
    {
        if (_targets.ResolveEditTarget(plugin, formKey, out var target) is { } blocked) return blocked;
        var (_, identity, unit, repository) = target;
        if (WriteTargets.RefuseIfHeader(identity.RecordType) is { } headerRefusal) return headerRefusal;

        // One changed document either way: the owner without the child, or the record's own gone.
        // Every descendant's row follows from that once it is re-indexed.
        var removal = repository.Remove(plugin, identity);
        if (removal != SourceRemoval.Removed)
        {
            // States only what is observed: either the tree names no document for it, or the document
            // it names lacks it.
            var observed = removal == SourceRemoval.NoDocumentHoldsIt
                ? $"No document in {plugin.Name}'s tree holds {formKey}."
                : $"{unit.RelativePath} was found holding {formKey}, but its own text does not carry it.";
            return RecordEditResult.Refused(
                RecordEditRefusal.SourceUnitNotFound,
                $"{observed} If nothing outside Modbench changed that file, this is a defect — please " +
                "report it; otherwise relaunch mEdit so the index re-reads the tree.");
        }

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation(
                "Deleted {FormKey} from {Plugin} ({Origin}) — working-tree deletion of {SourcePath}",
                formKey, plugin.Name, plugin.Origin, unit.RelativePath);
        }
        return RecordEditResult.Success();
    }
}
