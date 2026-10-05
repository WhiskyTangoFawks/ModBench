using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using Microsoft.Extensions.Logging;

namespace MEditService.Commands;

/// <summary>The Edit gesture's handler (ADR-0014): it writes the changes the edit makes to plugin source.</summary>
public sealed class EditRecordHandler
{
    private readonly RecordEdit _edit;
    private readonly ILogger<EditRecordHandler> _logger;

    // Internal because the shared module is, which is why this assembly registers its own handlers
    // (MEditService.Commands.Composition) rather than the host naming a type it cannot see.
    internal EditRecordHandler(RecordEdit edit, ILogger<EditRecordHandler> logger) => (_edit, _logger) = (edit, logger);

    public RecordEditResult Edit(PluginAddress plugin, string formKey, RecordEditEnvelope envelope)
    {
        var plan = _edit.Plan(plugin, formKey, envelope, given: null);
        var written = SourceCommit.Apply(plan, _logger);
        if (written.Applied && plan.Repository is not null && _logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation(
                "Edited {Op} {Path} on {FormKey} in {Plugin} ({Origin}): moved {Moves}, wrote {Documents}",
                envelope.Op, RecordEditEnvelope.Spell(envelope.Path), formKey, plugin.Name, plugin.Origin,
                plan.Changes.Moves.Select(move => $"{move.From} to {move.To}"), plan.Changes.Documents.Select(document => document.Path));
        }
        return written;
    }
}
