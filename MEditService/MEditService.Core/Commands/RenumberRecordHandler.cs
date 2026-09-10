using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Commands;

/// <summary>The Renumber gesture's handler (ADR-0046 invariant 3): the record's FormKey moves, and
/// every FormLink pointing at it moves with it (ADR-0041).</summary>
public sealed class RenumberRecordHandler
{
    // The write side's shared concerns (ADR-0046): the renumber resolves its edit target behind the
    // pre-write gate and draws its new FormKey, both through this one module.
    private readonly WriteTargets _targets;
    private readonly LoadOrderHolder _loadOrder;
    private readonly IModImporter _importer;
    private readonly RecordTextCodec _codec;
    private readonly SchemaReflector _schemaReflector;
    private readonly ILogger<RenumberRecordHandler> _logger;

    // Internal because the shared module is, which is why this assembly registers its own handlers
    // (MEditService.Core.Composition) rather than the host naming a type it cannot see.
    internal RenumberRecordHandler(
        WriteTargets targets,
        LoadOrderHolder loadOrder,
        IModImporter importer,
        RecordTextCodec codec,
        SchemaReflector schemaReflector,
        ILogger<RenumberRecordHandler> logger)
    {
        (_targets, _loadOrder, _importer, _codec, _schemaReflector, _logger) =
            (targets, loadOrder, importer, codec, schemaReflector, logger);
    }

    /// <summary>A delete+create pair in source terms plus a reference cascade. Native records only; an
    /// untracked referencer refuses before any write. Computed whole, then written through a
    /// <see cref="SourceTransaction"/> that restores every tree on failure (ADR-0045).</summary>
    public RecordEditResult RenumberRecord(PluginKey plugin, string formKey, string? requestedFormKey = null)
    {
        if (_targets.ResolveEditTarget(plugin, formKey, out var target) is { } blocked) return blocked;
        var (release, identity, unit, repository) = target;
        if (WriteTargets.RefuseIfHeader(identity.RecordType) is { } headerRefusal) return headerRefusal;

        // Canonicalised once: two ordinal comparisons below (the exclusion predicate and the
        // remap-completeness guard) run against canonical text, and a differently-cased spelling
        // would silently turn both into no-ops.
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

        var (referencers, untrackedReferencers) =
            new ReferencerScan(_loadOrder.Current, _importer, _codec, _schemaReflector, _logger).Of(formKey, plugin);
        if (untrackedReferencers.Count > 0)
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.UntrackedReferencer,
                $"{formKey} is referenced by untracked plugin(s) {string.Join(", ", untrackedReferencers)}, " +
                "so the renumber cannot rewrite their FormLinks. Track them first, then try again.");
        }

        // Phase one: nothing below this point touches the filesystem. Any refusal it returns is
        // returned with the tree exactly as this method found it.
        if (ComputeReferencerRewrites(formKey, targetFormKey, release, referencers, out var rewrites)
            is { } refusedReferencer) return refusedReferencer;
        if (ComputeTargetRewrite(plugin, repository, identity, unit, formKey, targetFormKey, release, out var targetRewrite)
            is { } refusedSelf) return refusedSelf;

        // Phase two: everything that can still fail is genuine I/O, recorded in one transaction
        // (ADR-0045).
        var transaction = new SourceTransaction();
        try
        {
            foreach (var rewrite in rewrites) WriteComputedRewrite(transaction, rewrite, release);
            WriteTargetRewrite(transaction, plugin, targetRewrite, targetFormKey, release);
        }
        catch (Exception ex)
        {
            // Unfiltered so an unexpected fault is rolled back and disclosed rather than falling
            // through to the endpoint's InvalidOperationException handler ("no usable load order").
            // Rethrown as IOException so it reaches the client as the same 500 every write fault does.
            throw new IOException(RollBackFailedRenumber(transaction, plugin, rewrites, formKey, targetFormKey, ex), ex);
        }

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation(
                "Renumbered {OldFormKey} to {NewFormKey} in {Plugin} ({Origin}), rewriting {Count} referencing record(s)",
                formKey, targetFormKey, plugin.Name, plugin.Origin, referencers.Count);
        }
        return RecordEditResult.Success(targetFormKey);
    }

    // Only the trees are put back (ADR-0045); the Source watcher lands the restored files. Paths
    // are relative to the mod folder, the form the Source Control panel lists.
    private string RollBackFailedRenumber(
        SourceTransaction transaction, PluginKey plugin, IReadOnlyList<ComputedRewrite> rewrites,
        string oldFormKey, string newFormKey, Exception cause)
    {
        var unrestored = transaction.Rollback();
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

        var modFolders = rewrites.Select(r => r.ModFolder).Append(ModFolders.Of(_loadOrder.Current, plugin))
            .OfType<string>().Distinct().ToList();
        sentences.Add($"Underlying error: {RelativeToModFolders(cause.Message, modFolders)}");
        return string.Join(" ", sentences);
    }

    // The cause is the only thing that says why, so it is relativized rather than dropped; the log
    // keeps the untouched original. Textual, since an exception message is prose.
    private static string RelativeToModFolders(string message, IReadOnlyList<string> modFolders) =>
        modFolders
            .OrderByDescending(f => f.Length)
            .Aggregate(message, (text, folder) => text.Replace(folder + Path.DirectorySeparatorChar, "", StringComparison.Ordinal));

    private static string? NamedPaths(
        IReadOnlyList<UnrestoredPath> unrestored, UnrestoredReason reason, string phrase)
    {
        var named = unrestored.Where(u => u.Reason == reason).Select(u => u.RelativePath).ToList();
        return named.Count == 0 ? null : $"{string.Join(", ", named)} — {phrase}.";
    }

    // Record is the file's top-level record: the referencer itself, or its owner when embedded.
    // Owner is the document's own identity, Record the graph its whole text serializes from.
    private sealed record ComputedRewrite(
        PluginKey Plugin, SourceRepository Repository, RecordIdentity Owner, IMajorRecord Record)
    {
        internal string ModFolder => Repository.ModFolder;
    }

    // One document at a time, which is what the scan answers with: a container holding several
    // referencers is remapped once. The typed remap moves links and only links, and the
    // remap-completeness guard below covers its one gap.
    private RecordEditResult? ComputeReferencerRewrites(
        string oldFormKey, string newFormKey, GameRelease release,
        IReadOnlyList<ReferencerScan.Referencing> referencers,
        out List<ComputedRewrite> rewrites)
    {
        rewrites = [];
        var mapping = RenumberMapping(oldFormKey, newFormKey);
        var schemas = _schemaReflector.GetSchemas(release);

        foreach (var (referencerPlugin, referencerRepository, document, schemaType, embeddedFormKeys) in referencers)
        {
            // Asked before the codec is: a document the scan could not run the collector over is one
            // this pass cannot read either, and a guard that cannot run has cleared nothing.
            if (schemaType is null)
            {
                return RecordEditResult.Refused(
                    RecordEditRefusal.ReferenceRemapIncomplete,
                    $"A document in {referencerPlugin.Name}'s tree naming {document.FormKey} could not be " +
                    $"read, so whether it links {oldFormKey} cannot be answered. Nothing was written.");
            }
            if (!schemas.ContainsKey(schemaType))
                return RefuseNoSchema(document.FormKey, schemaType, referencerPlugin);

            var owner = _codec.Deserialize(document.Body, release, document.RecordType);
            ((IFormLinkContainer)owner).RemapLinks(mapping);
            if (RefuseIfRemapIncomplete(owner, schemaType, oldFormKey, referencerPlugin, release) is { } incomplete)
                return incomplete;

            foreach (var embeddedFormKey in embeddedFormKeys)
            {
                // A remap never moves a record's own FormKey, so the child is still found under it.
                if (ContainerChildFields.FindEmbeddedChild(owner, embeddedFormKey)?.Child is not { } child) continue;

                // The owner's own walk never reaches a child's VMAD — an embedded referencer's
                // struct-list link is its own record's, and has to be asked of the child directly.
                if (RefuseIfRemapIncomplete(
                        child, SourceRecordType.Resolve(child, schemas), oldFormKey, referencerPlugin, release)
                    is { } childIncomplete) return childIncomplete;
            }

            // Carried rather than recomputed at write time: the transaction names unrestored paths
            // relative to this repository's folder.
            rewrites.Add(new ComputedRewrite(
                referencerPlugin, referencerRepository,
                new RecordIdentity(document.FormKey, schemaType, document.EditorId), owner));
        }

        return null;
    }

    // The guard's conservative direction: a guard that cannot run has cleared nothing, so a document
    // whose type the schema does not name stops the gesture rather than being passed over.
    private static RecordEditResult RefuseNoSchema(string formKey, string recordType, PluginKey plugin) =>
        RecordEditResult.Refused(
            RecordEditRefusal.ReferenceRemapIncomplete,
            $"'{recordType}' has no reflected schema, so the remap-completeness check for " +
            $"{formKey} in {plugin.Name} could not run. Nothing was written.");

    private static Dictionary<FormKey, FormKey> RenumberMapping(string oldFormKey, string newFormKey) =>
        new() { [FormKey.Factory(oldFormKey)] = FormKey.Factory(newFormKey) };

    // A link the typed remap left behind is refused wherever it sits; a KnownDefects row is what
    // names the member Mutagen is known to skip. Asked of the collector: text cannot tell a link
    // from an EditorID or string.
    private RecordEditResult? RefuseIfRemapIncomplete(
        IMajorRecordGetter record, string recordType, string oldFormKey, PluginKey plugin, GameRelease release)
    {
        if (!_schemaReflector.GetSchemas(release).TryGetValue(recordType, out var schema))
            return RefuseNoSchema(record.FormKey.ToString(), recordType, plugin);

        List<FormReference> refs;
        using (var document = JsonDocument.Parse(_codec.SerializeToText(record, release)))
            refs = FormReferences.Collect(document.RootElement, schema);
        if (refs.FirstOrDefault(r => r.TargetFormKey == oldFormKey) is { TargetFormKey: not null } stale)
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.ReferenceRemapIncomplete,
                $"{record.FormKey} in {plugin.Name} still links {oldFormKey} at {stale.FieldPath} after the " +
                $"typed link remap, so renumbering would leave that reference dangling. {WhyRemapIsIncomplete(stale, release)} " +
                "Nothing was written.");
        }

        return null;
    }

    // A reference path is member names separated by dots, with an element index in brackets.
    private static readonly char[] PathHopSeparators = ['.', '['];

    // The row whose member the surviving link sits under, where one names it: the path is the
    // document's own member names, so a row's member name is a hop of it.
    private string WhyRemapIsIncomplete(FormReference stale, GameRelease release) =>
        _schemaReflector.DefectsWith(release, KnownDefectEffect.RenumberRemapIncomplete)
            .FirstOrDefault(d => stale.FieldPath.Split(PathHopSeparators).Contains(d.MemberName, StringComparer.Ordinal))
            is { } defect
                ? $"{defect.TypeName}.{defect.MemberName}: {defect.Reason}."
                : "No known-defect row names a member Mutagen's generated remap skips, so the cause is unknown.";

    // A referencer's remapped graph is its owning document's whole text, so the batch takes it as one
    // put against that document's own identity.
    private void WriteComputedRewrite(SourceTransaction transaction, ComputedRewrite rewrite, GameRelease release)
    {
        transaction.Put(
            rewrite.Repository, rewrite.Plugin,
            new SourceDocument(
                rewrite.Owner.FormKey, rewrite.Owner.RecordType, rewrite.Owner.EditorId,
                _codec.SerializeToText(rewrite.Record, release)));
    }

    // Root is the whole record the target's own document serializes from: the owner when embedded,
    // and Written is that document's identity. Held is the target's own identity, as the tree has it.
    private sealed record ComputedTarget(
        SourceRepository Repository, SourceUnit Unit, RecordIdentity Written, RecordIdentity Held,
        IMajorRecord Root);

    // The referencer pass skips the target, so this is the only place a self-link is remapped.
    // Nothing here writes; every failure mode is a typed refusal.
    private RecordEditResult? ComputeTargetRewrite(
        PluginKey plugin, SourceRepository repository, RecordIdentity identity, SourceUnit unit,
        string oldFormKey, string newFormKey, GameRelease release, out ComputedTarget target)
    {
        target = null!;
        var mapping = RenumberMapping(oldFormKey, newFormKey);
        var schemas = _schemaReflector.GetSchemas(release);

        if (unit.IsEmbedded)
        {
            if (repository.IdentityOf(plugin, unit.OwnerFormKey, schemas) is not { } ownerIdentity
                || repository.Get(plugin, ownerIdentity) is not { } ownerDocument)
            {
                return RecordEditResult.Refused(
                    RecordEditRefusal.SourceUnitNotFound,
                    $"No document in {plugin.Name}'s tree holds {unit.OwnerFormKey}, the record " +
                    $"{unit.RelativePath} carries {oldFormKey} inside. Nothing was written.");
            }

            var owner = _codec.Deserialize(ownerDocument.Body, release, ownerDocument.RecordType);
            if (ContainerChildFields.FindEmbeddedChild(owner, oldFormKey) is not { } found)
            {
                return RecordEditResult.Refused(
                    RecordEditRefusal.SourceUnitNotFound,
                    $"{unit.RelativePath} was found holding {oldFormKey}, but its own text does not carry it. " +
                    "Nothing was written.");
            }

            // Remapped on the owner, not the child: a sibling embedded in the same document may hold
            // the self-link, and its own file is this same one.
            ((IFormLinkContainer)owner).RemapLinks(mapping);

            // Guarded before the new FormKey is stamped on, so a refusal names the record the user
            // asked about.
            if (RefuseIfRemapIncomplete(owner, ownerIdentity.RecordType, oldFormKey, plugin, release) is { } ownerIncomplete)
                return ownerIncomplete;
            if (RefuseIfRemapIncomplete(found.Child, identity.RecordType, oldFormKey, plugin, release) is { } childIncomplete)
                return childIncomplete;

            ((IMajorRecordInternal)found.Child).FormKey = FormKey.Factory(newFormKey);

            target = new ComputedTarget(repository, unit, ownerIdentity, identity, owner);
            return null;
        }

        if (repository.Get(plugin, identity) is not { } document)
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.SourceUnitNotFound,
                $"No source unit in {plugin.Name}'s tree holds {oldFormKey}. Nothing was written.");
        }

        var record = _codec.Deserialize(document.Body, release, document.RecordType);
        ((IFormLinkContainer)record).RemapLinks(mapping);

        if (RefuseIfRemapIncomplete(record, identity.RecordType, oldFormKey, plugin, release) is { } recordIncomplete)
            return recordIncomplete;

        ((IMajorRecordInternal)record).FormKey = FormKey.Factory(newFormKey);

        target = new ComputedTarget(
            repository, unit, new RecordIdentity(newFormKey, identity.RecordType, identity.EditorId),
            identity, record);
        return null;
    }

    private void WriteTargetRewrite(
        SourceTransaction transaction, PluginKey plugin, ComputedTarget target, string newFormKey,
        GameRelease release)
    {
        var (repository, unit, written, held, root) = target;
        var text = _codec.SerializeToText(root, release);

        // No file moves for an embedded record — it has no leaf name of its own — so the owner's own
        // document, reserialized around the child's new FormKey, is the whole write.
        if (unit.IsEmbedded)
        {
            transaction.Put(repository, plugin, new SourceDocument(written.FormKey, written.RecordType, written.EditorId, text));
            return;
        }

        // A container is moved whole rather than recreated from scratch: a worldspace's block subtree
        // travels with it rather than being orphaned, which no put-then-remove pair can express.
        if (unit.IsDirectoryPerRecord)
        {
            var oldLeafPath = Path.GetDirectoryName(unit.FullPath)!;
            var newLeafPath = Path.Combine(
                Path.GetDirectoryName(oldLeafPath)!,
                SourceRepository.LeafNameFor(FormKey.Factory(newFormKey), held.EditorId, isDirectory: true));

            transaction.Move(repository.ModFolder, oldLeafPath, newLeafPath);
            var writePath = Path.Combine(newLeafPath, SourceRepository.RecordDataFileName);
            transaction.Write(
                repository.ModFolder, writePath,
                () => _codec.SerializeAsync(root, writePath, release).GetAwaiter().GetResult());
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
