using MEditService.Codec.Serialization;
using MEditService.Commands.Resolution;
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
    private readonly ILogger _logger;

    internal NewRecordCopy(WriteTargets targets, RecordCopy recordCopy, ILogger logger)
    {
        (_targets, _recordCopy, _logger) = (targets, recordCopy, logger);
    }

    /// <summary>The fresh FormKey comes from the same allocator create draws on. A self-link is
    /// remapped onto it, as xEdit does.</summary>
    internal SourceAnswer<RecordEditResult> Copy(CopySource source, string formKey, PluginAddress destinationPlugin)
    {
        if (_targets.ResolveCopySource(destinationPlugin, source, formKey, out var copy) is { } blocked) return blocked;
        return CopyAsNewRecord(copy, destinationPlugin);
    }

    private SourceAnswer<RecordEditResult> CopyAsNewRecord(WriteTargets.CopyTarget copy, PluginAddress destinationPlugin)
    {
        var (source, identity, destination, release, _) = copy;
        if (RefuseIfDisallowedForCopyAsNewRecord(identity.RecordType, RecordTypes.For(release)) is { } disallowedRefusal) return disallowedRefusal;

        if (!source.ContainerOf(identity).Holds(out var container, out var why)) return WriteTargets.RefuseUnreadableSource(identity.FormKey, why);
        if (container is { } held) return CopyChildAsNewRecord(copy, held, destinationPlugin);

        return CopyUnderNextFormKey(
            copy, destinationPlugin,
            (transaction, duplicate) =>
            {
                transaction.Apply(destination.Repository.ChangesToPut(destinationPlugin, duplicate));
                return SourceAnswer.Of(RecordEditResult.Success());
            },
            "new working-tree source document");
    }

    private SourceAnswer<RecordEditResult> CopyChildAsNewRecord(
        WriteTargets.CopyTarget copy, DocumentContainment container, PluginAddress destinationPlugin) =>
        CopyUnderNextFormKey(
            copy, destinationPlugin,
            (transaction, duplicate) => _recordCopy.PutChildInContainer(
                transaction, copy.Source, container, duplicate, copy.Destination, copy.Release),
            $"inside {container.ParentFormKey}'s {container.SlotName} slot");

    private SourceAnswer<RecordEditResult> CopyUnderNextFormKey(
        WriteTargets.CopyTarget copy, PluginAddress destinationPlugin,
        Func<SourceTransaction, SourceDocument, SourceAnswer<RecordEditResult>> land, string landedAt)
    {
        var (source, identity, destination, release, body) = copy;
        if (!FormKeyAllocator.Over(destination.Repository, destinationPlugin, release).Holds(out var allocator, out var unread)) return unread;
        if (allocator.Next(out var targetFormKey) is { } refusedTarget) return refusedTarget;
        if (!destination.Repository.EditorIdsHeld(destinationPlugin).Holds(out var editorIdsHeld, out unread)) return unread;

        var named = RecordDocumentEdits.DuplicatedWithoutChildren(
            body, release, identity.RecordType, targetFormKey, EditorIdDeriver(editorIdsHeld));
        var duplicate = new SourceDocument(targetFormKey, identity.RecordType, named.EditorId, named.Text);
        if (!SourceTransaction.Atomically(destination.Repository, transaction =>
                land(transaction, duplicate).Then(landing =>
                {
                    if (landing.Applied) transaction.Apply(allocator.HeaderChanges());
                    return SourceAnswer.Of(landing);
                })).Holds(out var landed, out unread))
        {
            return unread;
        }
        if (!landed.Applied) return landed;

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation(
                "Copied {FormKey} from {SourcePlugin} ({SourceOrigin}) as new record {NewFormKey} into " +
                "{DestinationPlugin} ({DestinationOrigin}) — {LandedAt}",
                identity.FormKey, source.Plugin.Name, source.Plugin.Origin, targetFormKey, destinationPlugin.Name,
                destinationPlugin.Origin, landedAt);
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
    // to sit in. Only the cell and the worldspace are named; the others have no schema table and
    // already refuse as RecordNotFound.
    private static RecordEditResult? RefuseIfDisallowedForCopyAsNewRecord(string recordType, RecordTypes types)
    {
        if (recordType != types.Cell && recordType != types.Worldspace) return null;

        return RecordEditResult.Refused(
            RecordEditRefusal.CopyAsNewRecordDisallowedForType,
            $"'{recordType}' cannot be copied as a new record — xEdit itself refuses this for container " +
            "types (CELL, WRLD, LAND, NAVM, PGRD, ROAD, NAVI), since a fresh FormKey would leave the copy " +
            "with no group to belong to. Copy as Override, instead.");
    }
}
