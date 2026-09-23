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
    private readonly ILogger<DeleteRecordHandler> _logger;

    // Internal because the shared module is, which is why this assembly registers its own handlers
    // (MEditService.Commands.Composition) rather than the host naming a type it cannot see.
    internal DeleteRecordHandler(WriteTargets targets, ILogger<DeleteRecordHandler> logger) =>
        (_targets, _logger) = (targets, logger);

    /// <summary>Every record shape resolves through the unit holding it.</summary>
    public RecordEditResult DeleteRecord(PluginCopyKey plugin, string formKey)
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
