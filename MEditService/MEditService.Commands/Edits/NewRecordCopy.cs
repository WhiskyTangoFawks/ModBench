using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;

namespace MEditService.Commands.Edits;

/// <summary>Copy's new mode, one record into one destination: xEdit's "Copy as New Record Into…" —
/// the codec's duplicate under the next free FormKey (plugins.md, Copy, story 2).</summary>
internal sealed class NewRecordCopy
{
    private readonly WriteTargets _targets;
    private readonly RecordCopy _recordCopy;
    private readonly RecordTextCodec _codec;
    private readonly ILogger _logger;

    internal NewRecordCopy(WriteTargets targets, RecordCopy recordCopy, RecordTextCodec codec, ILogger logger)
    {
        (_targets, _recordCopy, _codec, _logger) = (targets, recordCopy, codec, logger);
    }

    /// <summary>The fresh FormKey comes from the same allocator create draws on. A self-link is
    /// remapped onto it, as xEdit does.</summary>
    internal RecordEditResult Copy(PluginAddress sourcePlugin, string formKey, PluginAddress destinationPlugin)
    {
        if (_targets.ResolveCopySource(destinationPlugin, sourcePlugin, formKey, out var copy) is { } blocked) return blocked;
        using var source = copy.Source;
        try
        {
            return CopyAsNewRecord(copy, destinationPlugin);
        }
        catch (UnreadableSourceDocumentException ex)
        {
            return WriteTargets.RefuseUnreadableSourceTree(formKey, ex.Message);
        }
    }

    private RecordEditResult CopyAsNewRecord(WriteTargets.CopyTarget copy, PluginAddress destinationPlugin)
    {
        var (source, identity, destination, release, body) = copy;
        var formKey = identity.FormKey;
        if (RefuseIfDisallowedForCopyAsNewRecord(identity.RecordType) is { } disallowedRefusal) return disallowedRefusal;

        // A record with no group of its own copies into its container's document (a topic into its
        // quest, a response into its topic); a placed reference has no such container and refuses.
        if (RecordTypeDispatch.For(release).FolderNameFor(identity.RecordType) is null)
        {
            if (source.ContainerOf(identity) is { } container)
                return CopyEmbeddedChildAsNewRecord(copy, container, destinationPlugin);
            if (WriteTargets.RefuseIfContainerType(identity.RecordType, release) is { } containerRefusal) return containerRefusal;
        }

        if (FormKeyAllocator.Over(destination.Repository, destinationPlugin, release).Next(out var targetFormKey)
            is { } refusedTarget) return refusedTarget;

        // Own-record-only, like Copy as Override: a container's children never ride along (deep copy
        // is a separate operation).
        var duplicate = RecordDocumentEdits.DuplicatedWithoutChildren(
            _codec, body, release, identity.RecordType, targetFormKey,
            EditorIdDeriver(destination.Repository.EditorIdsHeld(destinationPlugin)));
        destination.Repository.Put(
            destinationPlugin,
            new SourceDocument(targetFormKey, identity.RecordType, duplicate.EditorId, duplicate.Text));

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation(
                "Copied {FormKey} from {SourcePlugin} ({SourceOrigin}) as new record {NewFormKey} into " +
                "{DestinationPlugin} ({DestinationOrigin}) — new working-tree source document",
                formKey, source.Plugin.Name, source.Plugin.Origin, targetFormKey, destinationPlugin.Name,
                destinationPlugin.Origin);
        }
        return RecordEditResult.Success(targetFormKey);
    }

    // The embedded subtree rides along, each record under a fresh key drawn before anything is written.
    // A missing container chain auto-creates bare and Partial Form.
    private RecordEditResult CopyEmbeddedChildAsNewRecord(
        WriteTargets.CopyTarget copy, DocumentContainment container, PluginAddress destinationPlugin)
    {
        var (source, identity, destination, release, body) = copy;

        var allocator = FormKeyAllocator.Over(destination.Repository, destinationPlugin, release);
        if (allocator.Next(out var targetFormKey) is { } refusedTarget) return refusedTarget;

        // Its own text carries its whole embedded subtree, so the codec has already read every
        // descendant by the time one can be re-keyed.
        var rekeys = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var descendant in RecordDocumentEdits.EmbeddedDescendantFormKeys(
                     _codec, body, release, identity.RecordType))
        {
            if (allocator.Next(out var childFormKey) is { } refused) return refused;
            rekeys[descendant] = childFormKey;
        }

        var duplicate = RecordDocumentEdits.DuplicatedWithSubtreeRekeyed(
            _codec, body, release, identity.RecordType, targetFormKey, rekeys,
            EditorIdDeriver(destination.Repository.EditorIdsHeld(destinationPlugin)));

        var appended = _recordCopy.AppendEmbeddedChild(
            source, container,
            new SourceDocument(targetFormKey, identity.RecordType, duplicate.EditorId, duplicate.Text),
            destination, release);
        if (!appended.Applied) return appended;

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation(
                "Copied {FormKey} from {SourcePlugin} ({SourceOrigin}) as new record {NewFormKey} into " +
                "{DestinationPlugin} ({DestinationOrigin}) — inside {ContainerFormKey}'s {SlotName} slot, " +
                "with {DescendantCount} embedded descendant(s) each under a fresh FormKey",
                identity.FormKey, source.Plugin.Name, source.Plugin.Origin, targetFormKey, destinationPlugin.Name,
                destinationPlugin.Origin, container.ParentFormKey, container.SlotName, rekeys.Count);
        }
        return RecordEditResult.Success(targetFormKey);
    }

    // The Creation Kit's own shape for a duplicate's EditorID: the source's name, "DUPLICATE" and a
    // three-digit counter, past whatever the destination already holds.
    private static Func<string?, string?> EditorIdDeriver(IReadOnlySet<string> heldInDestination)
    {
        var taken = new HashSet<string>(heldInDestination, StringComparer.OrdinalIgnoreCase);
        return sourceEditorId =>
        {
            if (sourceEditorId is null) return null;
            var n = 1;
            while (true)
            {
                var candidate = $"{sourceEditorId}DUPLICATE{n:D3}";
                if (taken.Add(candidate)) return candidate;
                n++;
            }
        };
    }

    // xEdit refuses CELL/WRLD/LAND/NAVM/PGRD/ROAD/NAVI: a fresh FormKey leaves the copy with no group
    // to sit in. Only cell/wrld are named; the others have no schema table and already refuse as
    // RecordNotFound.
    private static RecordEditResult? RefuseIfDisallowedForCopyAsNewRecord(string recordType)
    {
        if (recordType is not ("cell" or "wrld")) return null;

        return RecordEditResult.Refused(
            RecordEditRefusal.CopyAsNewRecordDisallowedForType,
            $"'{recordType}' cannot be copied as a new record — xEdit itself refuses this for container " +
            "types (CELL, WRLD, LAND, NAVM, PGRD, ROAD, NAVI), since a fresh FormKey would leave the copy " +
            "with no group to belong to. Copy as Override, instead.");
    }
}
