using System.Diagnostics;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands;

/// <summary>The Renumber gesture's handler (ADR-0014 invariant 3): the record's FormKey changes and
/// nothing else. The records that reference it are left as they are: updating them is a script.</summary>
public sealed class RenumberRecordHandler
{
    // The write side's shared concerns (ADR-0014): the renumber resolves its edit target behind the
    // pre-write gate and draws its new FormKey, both through this one module.
    private readonly WriteTargets _targets;
    private readonly RecordTextCodec _codec;
    private readonly SchemaReflector _schemaReflector;
    private readonly ILogger<RenumberRecordHandler> _logger;

    // Internal because the shared module is, which is why this assembly registers its own handlers
    // (MEditService.Commands.Composition) rather than the host naming a type it cannot see.
    internal RenumberRecordHandler(
        WriteTargets targets,
        RecordTextCodec codec,
        SchemaReflector schemaReflector,
        ILogger<RenumberRecordHandler> logger)
    {
        (_targets, _codec, _schemaReflector, _logger) = (targets, codec, schemaReflector, logger);
    }

    /// <summary>A delete+create pair in source terms. Native records only. Written through a
    /// <see cref="SourceRepository.SourceTransaction"/> that restores the tree on failure.</summary>
    public RecordEditResult RenumberRecord(PluginCopyKey plugin, string formKey, string? requestedFormKey = null)
    {
        if (_targets.ResolveEditTarget(plugin, formKey, out var target) is { } blocked) return blocked;
        var (release, identity, unit, repository) = target;
        if (WriteTargets.RefuseIfHeader(identity.RecordType) is { } headerRefusal) return headerRefusal;

        var parsedFormKey = FormKey.Factory(formKey);
        formKey = parsedFormKey.ToString();

        var originatingPlugin = parsedFormKey.ModKey.FileName.String;
        if (!originatingPlugin.Equals(plugin.Name, StringComparison.OrdinalIgnoreCase))
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.NotNativeRecord,
                $"{formKey} is an override in {plugin.Name} — {originatingPlugin} originated it. " +
                $"Renumber it there instead.");
        }

        if (_targets.ResolveTargetFormKey(repository, plugin, requestedFormKey, out var targetFormKey)
            is { } refusedTarget) return refusedTarget;

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
                RollBackFailedRenumber(transaction, repository, formKey, targetFormKey, ex));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            throw new IOException(RollBackFailedRenumber(transaction, repository, formKey, targetFormKey, ex), ex);
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            _logger.LogError(ex, "{Report}", RollBackFailedRenumber(transaction, repository, formKey, targetFormKey, ex));
            throw;
        }

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation(
                "Renumbered {OldFormKey} to {NewFormKey} in {Plugin} ({Origin})",
                formKey, targetFormKey, plugin.Name, plugin.Origin);
        }
        return RecordEditResult.Success(targetFormKey);
    }

    // Only the tree is put back; the Source watcher lands the restored files. Paths are relative to
    // the mod folder, the form the Source Control panel lists.
    private string RollBackFailedRenumber(
        SourceRepository.SourceTransaction transaction, SourceRepository repository,
        string oldFormKey, string newFormKey, Exception cause)
    {
        var (unrestored, relativeError) = transaction.Rollback(cause, repository);
        if (unrestored.Count > 0)
        {
            _logger.LogWarning(
                "Rolling back the failed renumber of {OldFormKey} left {Count} path(s) as they stood: {Paths}",
                oldFormKey, unrestored.Count,
                string.Join("; ", unrestored.Select(u => $"{u.FullPath} [{u.Reason}{(u.Error is null ? "" : $": {u.Error}")}]")));
        }

        var sentences = new List<string>
        {
            $"Renumbering {oldFormKey} to {newFormKey} failed.",
            unrestored.Count == 0
                ? "Every source tree it had written is back as it was — nothing to review or revert."
                : "Every source tree it had written is back as it was, except:",
        };

        sentences.AddRange(new[]
        {
            (UnrestoredReason.ChangedByAnother,
                "changed by something else after this renumber wrote them, so their current content was kept"),
            (UnrestoredReason.RemovedByAnother,
                "removed by something else after this renumber wrote them, so they were not put back"),
            (UnrestoredReason.OccupiedByAnother,
                "occupied by something else, so what this renumber moved away was not moved back"),
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

    // Text is the target's own document renumbered — the owner's whole text when embedded — and
    // Written is that document's identity. Held is the target's own identity, as the tree has it.
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
            if (repository.IdentityOf(plugin, unit.OwnerFormKey, _schemaReflector.GetSchemas(release)) is not { } ownerIdentity
                || repository.Get(plugin, ownerIdentity) is not { } ownerDocument)
            {
                return RecordEditResult.Refused(
                    RecordEditRefusal.SourceUnitNotFound,
                    $"No document in {plugin.Name}'s tree holds {unit.OwnerFormKey}, the record " +
                    $"{unit.RelativePath} carries {oldFormKey} inside. Nothing was written.");
            }

            if (RecordDocumentEdits.WithEmbeddedChildFormKey(
                    _codec, ownerDocument.Body, release, ownerDocument.RecordType, oldFormKey, newFormKey)
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
            RecordDocumentEdits.WithFormKey(_codec, document.Body, release, document.RecordType, newFormKey));
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
        // renumber wants; the embedded-only third would mean the tree changed under the put.
        if (removal == SourceRemoval.OwnerDoesNotCarryIt)
            throw new IOException($"The document holding {held.FormKey} does not carry it, so the renumber cannot take it out.");
    }
}
