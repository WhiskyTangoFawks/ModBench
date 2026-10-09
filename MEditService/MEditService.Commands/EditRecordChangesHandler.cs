using System.Text;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.Commands.Resolution;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;

namespace MEditService.Commands;

/// <summary>The Edit gesture answered as the changes it makes to plugin source, writing nothing: the document
/// is the caller's to change and save (ADR-0001). The target and its gate are <see cref="WriteTargets"/>'s.</summary>
public sealed class EditRecordChangesHandler
{
    private readonly WriteTargets _targets;
    private readonly LoadOrderResolution _resolution;
    private readonly SchemaReflector _schemaReflector;
    private readonly ILogger<EditRecordChangesHandler> _logger;
    private readonly FormKeyChange _formKeyChange;
    private readonly CellLanding _cellLanding;

    internal EditRecordChangesHandler(
        WriteTargets targets, LoadOrderResolution resolution, SchemaReflector schemaReflector,
        ILogger<EditRecordChangesHandler> logger)
    {
        (_targets, _resolution, _schemaReflector, _logger) = (targets, resolution, schemaReflector, logger);
        _formKeyChange = new(logger);
        _cellLanding = new(resolution, schemaReflector, logger);
    }

    /// <summary><paramref name="given"/> stands in for the file of the document carrying the record.</summary>
    public RecordEditChanges Changes(PluginAddress plugin, string formKey, RecordEditEnvelope envelope, string given) =>
        WriteFailure.Refused(
            EditSource(plugin, formKey, envelope, given), refused => refused, $"Could not read the source of {formKey}", _logger);

    private SourceAnswer<RecordEditChanges> EditSource(PluginAddress plugin, string formKey, RecordEditEnvelope envelope, string given)
    {
        if (ItemWrite.RefuseWithoutGit() is { } gitMissing) return gitMissing;
        if (!_targets.TryResolveEditTarget(plugin, formKey, given, out var onDisk, out _, out var blocked)) return blocked;
        if (!onDisk.Repository.DocumentOf(plugin, onDisk.Identity).Holds(out var file, out var unread)) return unread;
        var carrying = file ?? throw new InvalidOperationException($"Expected the document carrying {formKey} to have been located.");

        var batch = SourceBatch.Over(onDisk.Repository, [new DocumentChange(carrying.Path, given)]);
        if (!batch.Repository.CarryingFromText(plugin, formKey, given).Holds(out var found, out unread)) return unread;
        var (_, document) = found ?? throw new InvalidOperationException($"Expected the batch to read {formKey} where the tree found it.");
        var editTarget = onDisk with { Repository = batch.Repository };
        return SourceTransaction.Atomically(batch.Repository, transaction =>
                EditDocument(plugin, formKey, envelope, editTarget, document).Then(edit =>
                {
                    transaction.Apply(SourceAnswer.Of(edit.Changes));
                    return SourceAnswer.Of(edit.Outcome);
                }))
            .Then(outcome => SourceAnswer.Of(new RecordEditChanges(outcome, batch.Changes)));
    }

    private SourceAnswer<RecordEditChanges> EditDocument(
        PluginAddress plugin, string formKey, RecordEditEnvelope envelope, WriteTargets.EditTarget editTarget, SourceDocument document)
    {
        var (release, identity, repository) = editTarget;
        var schemas = _schemaReflector.GetSchemas(release);
        if (FormKeyChange.IsFormIdEdit(envelope)) return _formKeyChange.Change(plugin, formKey, editTarget, document, envelope.Value);
        var isEmbedded = !document.FormKey.Equals(identity.FormKey, StringComparison.Ordinal);
        var spelled = RecordEditEnvelope.Spell(envelope.Path);

        if (!schemas.TryGetValue(identity.RecordType, out var schema))
        {
            return RecordEditResult.RefusedAt(
                RecordEditRefusal.FieldNotFound, spelled, $"'{identity.RecordType}' is not an editable record type.");
        }

        // The parent is what the file holds and what the codec reads, so every untouched byte of it
        // comes back intact.
        var target = document.Identity;
        var text = document.Body;
        IReadOnlyList<PathHop> prefix = [];
        if (isEmbedded)
        {
            if (!repository.RelativePathOf(plugin, identity).Holds(out var located, out var unread)) return unread;
            var relativePath = located
                ?? throw new InvalidOperationException($"Expected the document carrying {formKey} to have been located.");
            var found = EmbeddedChildLocator.Find(
                Encoding.UTF8.GetBytes(text), target.RecordType, formKey, release);
            if (found is not { } span)
            {
                return RecordEditResult.Refused(
                    RecordEditRefusal.SourceUnitNotFound, SourceFailure.NotCarried.FoundButNotCarried(relativePath, formKey));
            }
            prefix = EmbeddedChildPath.HopsOf(span.Path);
        }

        Func<string, string> roundTrip = schema.IsHeader
            ? patched => Encoding.UTF8.GetString(HeaderDocument.Write(HeaderDocument.Read(Encoding.UTF8.GetBytes(patched))))
            : patched => RecordTextCodec.RoundTrip(patched, release, document.RecordType);

        var request = new DocumentEditRequest(
            text, prefix, schema, envelope, release, roundTrip, _resolution.WalkAmongMastersOf(repository, plugin, schemas));

        string newText;
        CellCrossing? crossing;
        RecordEditResult? refused;
        try
        {
            refused = DocumentEdit.Patch(request, out newText, out crossing);
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            // A document JsonDocument tolerates and JsonNode does not — duplicate members, most of
            // them — never reaches the codec, and this is the only reader that sees why.
            return WriteTargets.RefuseUnreadable(formKey, ex.Message, spelled);
        }
        // The codec rejected the patched document; whether the unpatched one reads decides whose fault
        // that is, and it is only asked once an edit has already failed.
        if (refused is { Refusal: RecordEditRefusal.CodecRejected } && Unreadable(roundTrip, text) is { } why)
            return WriteTargets.RefuseUnreadable(formKey, why, spelled);
        if (refused is { } rejected) return rejected;
        if (crossing is { } leaving) return _cellLanding.Land(plugin, editTarget, target, newText, leaving, spelled);

        // The document already said this (a value set to itself): nothing to commit, so no dirty file
        // or history entry.
        if (string.Equals(newText, text, StringComparison.Ordinal)) return RecordEditResult.Success();

        return RecordEditChanges.Making(
            RecordEditResult.Success(),
            repository.ChangesToRewrite(plugin, new SourceDocument(target.FormKey, target.RecordType, EditorIds.In(newText), newText)));
    }

    private static string? Unreadable(Func<string, string> roundTrip, string text)
    {
        try
        {
            roundTrip(text);
            return null;
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            return ex.Message;
        }
    }
}
