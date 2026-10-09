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

    /// <summary><paramref name="given"/> stands in for the file of the document holding the record.</summary>
    public RecordEditChanges Changes(PluginAddress plugin, string formKey, RecordEditEnvelope envelope, string given) =>
        WriteFailure.Refused(
            EditSource(plugin, formKey, envelope, given), refused => refused, $"Could not read the source of {formKey}", _logger);

    private SourceAnswer<RecordEditChanges> EditSource(PluginAddress plugin, string formKey, RecordEditEnvelope envelope, string given)
    {
        if (ItemWrite.RefuseWithoutGit() is { } gitMissing) return gitMissing;
        if (!_targets.TryResolveEditTarget(plugin, formKey, given, out var onDisk, out var blocked)) return blocked;
        if (!onDisk.Repository.DocumentOf(plugin, onDisk.Identity).Holds(out var file, out var unread)) return unread;
        var documentFile = file ?? throw new InvalidOperationException($"Expected the document holding {formKey} to have been located.");

        var batch = SourceBatch.Over(onDisk.Repository, [new DocumentChange(documentFile.Path, given)]);
        return Edit(plugin, formKey, envelope, onDisk with { Repository = batch.Repository })
            .Then(outcome => SourceAnswer.Of(new RecordEditChanges(outcome, batch.Changes)));
    }

    private SourceAnswer<RecordEditResult> Edit(
        PluginAddress plugin, string formKey, RecordEditEnvelope envelope, WriteTargets.EditTarget editTarget)
    {
        var (release, identity, repository) = editTarget;
        if (FormKeyChange.IsFormIdEdit(envelope)) return _formKeyChange.Change(plugin, formKey, editTarget, envelope.Value);
        var schemas = _schemaReflector.GetSchemas(release);
        var spelled = RecordEditEnvelope.Spell(envelope.Path);

        if (!schemas.TryGetValue(identity.RecordType, out var schema))
        {
            return RecordEditResult.RefusedAt(
                RecordEditRefusal.FieldNotFound, spelled, $"'{identity.RecordType}' is not an editable record type.");
        }

        if (!repository.RecordOf(plugin, identity).Holds(out var own, out var unread)) return unread;
        var text = (own ?? throw new InvalidOperationException($"Expected the text given for {formKey} to carry it.")).Body;
        if (!HeldIn.Of(repository, plugin, identity).Holds(out var held, out unread)) return unread;

        Func<string, string> roundTrip = schema.IsHeader
            ? patched => Encoding.UTF8.GetString(HeaderDocument.Write(HeaderDocument.Read(Encoding.UTF8.GetBytes(patched))))
            : patched => RecordTextCodec.RoundTrip(patched, release, identity.RecordType);

        var request = new RecordTextEditRequest(
            text, held, schema, envelope, release, roundTrip, _resolution.WalkAmongMastersOf(repository, plugin, schemas));

        string newText;
        CellGroupMove? move;
        RecordEditResult? refused;
        try
        {
            refused = RecordTextEdit.Patch(request, out newText, out move);
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

        var written = new SourceDocument(identity.FormKey, identity.RecordType, EditorIds.In(newText), newText);
        if (move is { Into: { } into }) return _cellLanding.Land(plugin, editTarget, move.From, written, into, spelled);
        if (move is { StaysInItsCell: true })
        {
            return RecordEditResult.Making(RecordEditResult.Success(), repository, transaction =>
            {
                transaction.Apply(repository.ChangesToRemove(plugin, identity));
                transaction.Apply(repository.ChangesToPutChild(plugin, move.From.Container.Identity, move.Destination, written));
            });
        }

        // The record already said this (a value set to itself): nothing to commit, so no dirty file
        // or history entry.
        if (string.Equals(newText, text, StringComparison.Ordinal)) return RecordEditResult.Success();

        return RecordEditResult.Making(
            RecordEditResult.Success(), repository, transaction => transaction.Apply(repository.ChangesToRewrite(plugin, written)));
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
