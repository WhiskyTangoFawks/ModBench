using System.Diagnostics;
using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Edits;

/// <summary>An edit of a record's FormID changes its FormKey and nothing else: the records that
/// reference it, itself included, are left as they are, and updating them is a script.</summary>
internal sealed class FormKeyChange(
    WriteTargets targets, RecordTextCodec codec, SchemaReflector schemaReflector, ILogger logger)
{
    /// <summary>The document member a record's FormID is, which the edit's path names.</summary>
    internal const string Member = "FormKey";

    /// <summary>Whether the envelope sets the record's FormID rather than a field of its document.</summary>
    internal static bool IsFormIdEdit(RecordEditEnvelope envelope) =>
        envelope is { Op: RecordEditEnvelope.Set, Path: [{ Kind: PathHop.MemberKind, Name: Member }] };

    /// <summary>A delete+create pair in source terms, written through a
    /// <see cref="SourceRepository.SourceTransaction"/> that restores the tree on failure.</summary>
    internal RecordEditResult Change(
        PluginCopyKey plugin, string formKey, WriteTargets.EditTarget editTarget, JsonElement? value)
    {
        var (release, identity, unit, repository) = editTarget;
        if (identity.RecordType == PluginHeader.RecordType)
        {
            return RecordEditResult.RefusedAt(
                RecordEditRefusal.FieldReadOnly, Member,
                $"A plugin header's FormID is read-only: {formKey} names {plugin.Name} itself, not a record in it.");
        }

        if (value is not { ValueKind: JsonValueKind.String } text
            || !FormKey.TryFactory(text.GetString(), out var requested))
        {
            return RecordEditResult.RefusedAt(
                RecordEditRefusal.CodecRejected, Member,
                $"{(value is { } given ? given.GetRawText() : "Nothing")} is not a FormKey. A FormID is written " +
                $"as its FormKey, the local ID in hex and then the plugin it is native to: 000800:{plugin.Name}.");
        }

        var parsedFormKey = FormKey.Factory(formKey);
        formKey = parsedFormKey.ToString();
        var requestedFormKey = requested.ToString();
        if (requestedFormKey == formKey) return RecordEditResult.Success();

        var originatingPlugin = parsedFormKey.ModKey.FileName.String;
        if (!originatingPlugin.Equals(plugin.Name, StringComparison.OrdinalIgnoreCase))
        {
            return RecordEditResult.RefusedAt(
                RecordEditRefusal.NotNativeRecord, Member,
                $"{formKey} is an override in {plugin.Name}: {originatingPlugin} is its master. " +
                $"Change its FormID in {originatingPlugin}, where the record is native.");
        }

        if (targets.ResolveTargetFormKey(repository, plugin, requestedFormKey, out var targetFormKey)
            is { } refusedTarget) return refusedTarget with { Path = Member };

        // A tree not as this gesture needs it is a refusal (ADR-0014 invariant 4); a filesystem fault is a
        // write failure; anything else is a bug. Only the transaction writes.
        var transaction = new SourceRepository.SourceTransaction();
        try
        {
            if (ComputeTargetRewrite(plugin, repository, identity, unit, formKey, targetFormKey, release, out var targetRewrite)
                is { } refusedSelf) return refusedSelf;
            WriteTargetRewrite(
                transaction, plugin,
                targetRewrite ?? throw new UnreachableException("ComputeTargetRewrite neither refused nor computed a target."),
                targetFormKey);
        }
        catch (Exception ex) when (ex is InvalidOperationException or NotSupportedException)
        {
            return RecordEditResult.Refused(
                ex is AmbiguousSourceUnitException ? RecordEditRefusal.AmbiguousSourceUnit : RecordEditRefusal.SourceUnitNotFound,
                RollBackFailedChange(transaction, repository, formKey, targetFormKey, ex));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            throw new IOException(RollBackFailedChange(transaction, repository, formKey, targetFormKey, ex), ex);
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            logger.LogError(ex, "{Report}", RollBackFailedChange(transaction, repository, formKey, targetFormKey, ex));
            throw;
        }

        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "Changed the FormID of {OldFormKey} to {NewFormKey} in {Plugin} ({Origin})",
                formKey, targetFormKey, plugin.Name, plugin.Origin);
        }
        return RecordEditResult.Success(targetFormKey);
    }

    // Only the tree is put back; the Source watcher lands the restored files. Paths are relative to
    // the mod folder, the form the Source Control panel lists.
    private string RollBackFailedChange(
        SourceRepository.SourceTransaction transaction, SourceRepository repository,
        string oldFormKey, string newFormKey, Exception cause)
    {
        var (unrestored, relativeError) = transaction.Rollback(cause, repository);
        if (unrestored.Count > 0)
        {
            logger.LogWarning(
                "Rolling back the failed FormID change of {OldFormKey} left {Count} path(s) as they stood: {Paths}",
                oldFormKey, unrestored.Count,
                string.Join("; ", unrestored.Select(u => $"{u.FullPath} [{u.Reason}{(u.Error is null ? "" : $": {u.Error}")}]")));
        }

        var sentences = new List<string>
        {
            $"Changing the FormID of {oldFormKey} to {newFormKey} failed.",
            unrestored.Count == 0
                ? "Every source tree it had written is back as it was — nothing to review or revert."
                : "Every source tree it had written is back as it was, except:",
        };

        sentences.AddRange(new[]
        {
            (UnrestoredReason.ChangedByAnother,
                "changed by something else after this FormID change wrote them, so their current content was kept"),
            (UnrestoredReason.RemovedByAnother,
                "removed by something else after this FormID change wrote them, so they were not put back"),
            (UnrestoredReason.OccupiedByAnother,
                "occupied by something else, so what this FormID change moved away was not moved back"),
            (UnrestoredReason.RestoreFailed, "could not be restored"),
        }.Select(r => NamedPaths(unrestored, r.Item1, r.Item2)).OfType<string>());

        sentences.Add($"Underlying error: {relativeError}");
        return string.Join(" ", sentences);
    }

    private static string? NamedPaths(
        IReadOnlyList<UnrestoredPath> unrestored, UnrestoredReason reason, string phrase)
    {
        var named = unrestored.Where(u => u.Reason == reason).Select(u => u.RelativePath).ToList();
        return named.Count == 0 ? null : $"{string.Join(", ", named)} — {phrase}.";
    }

    // Text is the target's own document under its new FormKey — the owner's whole text when
    // embedded — and Written is that document's identity. Held is the target's own identity, as the
    // tree has it.
    private sealed record ComputedTarget(
        SourceRepository Repository, HoldingUnit Unit, RecordIdentity Written, RecordIdentity Held,
        string Text);

    // Nothing here writes; every failure mode is a typed refusal.
    private RecordEditResult? ComputeTargetRewrite(
        PluginCopyKey plugin, SourceRepository repository, RecordIdentity identity, HoldingUnit unit,
        string oldFormKey, string newFormKey, GameRelease release, out ComputedTarget? target)
    {
        target = null;

        if (unit.IsEmbedded)
        {
            if (repository.IdentityOf(plugin, unit.OwnerFormKey, schemaReflector.GetSchemas(release)) is not { } ownerIdentity
                || repository.Get(plugin, ownerIdentity) is not { } ownerDocument)
            {
                return RecordEditResult.Refused(
                    RecordEditRefusal.SourceUnitNotFound,
                    $"No document in {plugin.Name}'s tree holds {unit.OwnerFormKey}, the record " +
                    $"{unit.RelativePath} carries {oldFormKey} inside. Nothing was written.");
            }

            if (RecordDocumentEdits.WithEmbeddedChildFormKey(
                    codec, ownerDocument.Body, release, ownerDocument.RecordType, oldFormKey, newFormKey)
                is not { } ownerText)
            {
                return RecordEditResult.Refused(
                    RecordEditRefusal.SourceUnitNotFound,
                    $"{unit.RelativePath} was found holding {oldFormKey}, but its own text does not carry it. " +
                    "Nothing was written.");
            }

            target = new ComputedTarget(repository, unit, ownerIdentity, identity, ownerText);
            return null;
        }

        if (repository.Get(plugin, identity) is not { } document)
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.SourceUnitNotFound,
                $"No source unit in {plugin.Name}'s tree holds {oldFormKey}. Nothing was written.");
        }

        target = new ComputedTarget(
            repository, unit, new RecordIdentity(newFormKey, identity.RecordType, identity.EditorId), identity,
            RecordDocumentEdits.WithFormKey(codec, document.Body, release, document.RecordType, newFormKey));
        return null;
    }

    private static void WriteTargetRewrite(
        SourceRepository.SourceTransaction transaction, PluginCopyKey plugin, ComputedTarget target, string newFormKey)
    {
        var (repository, unit, written, held, text) = target;

        // No file moves for an embedded record — it has no leaf name of its own — so the owner's own
        // document, reserialized around the child's new FormKey, is the whole write.
        if (unit.IsEmbedded)
        {
            transaction.Put(repository, plugin, new SourceDocument(written.FormKey, written.RecordType, written.EditorId, text));
            return;
        }

        // A container moves whole rather than being recreated from scratch, its block subtree with it.
        // The move lands the directory at the new leaf, so the put that follows finds and replaces it.
        if (unit.IsDirectoryPerRecord)
        {
            transaction.Move(repository, plugin, held, newFormKey);
            transaction.Put(repository, plugin, new SourceDocument(written.FormKey, written.RecordType, written.EditorId, text));
            return;
        }

        // Only the FormKey half of a flat record's leaf name changes, which the put's own placement
        // computes; the remove then takes the file the old FormKey named.
        transaction.Put(repository, plugin, new SourceDocument(written.FormKey, written.RecordType, written.EditorId, text));
        var removal = transaction.Remove(repository, plugin, held);

        // Both outcomes a flat record can answer leave the old leaf gone, which is the state this
        // change wants; the embedded-only third would mean the tree changed under the put.
        if (removal == SourceRemoval.OwnerDoesNotCarryIt)
            throw new IOException($"The document holding {held.FormKey} does not carry it, so the FormID change cannot take it out.");
    }
}
