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
    private readonly RecordTextCodec _codec;
    private readonly ILogger _logger;

    internal NewRecordCopy(WriteTargets targets, RecordCopy recordCopy, RecordTextCodec codec, ILogger logger)
    {
        (_targets, _recordCopy, _codec, _logger) = (targets, recordCopy, codec, logger);
    }

    /// <summary>The fresh FormKey comes from the same allocator create draws on. A self-link is
    /// remapped onto it, as xEdit does.</summary>
    internal RecordEditResult Copy(CopySource source, string formKey, PluginAddress destinationPlugin)
    {
        if (_targets.ResolveCopySource(destinationPlugin, source, formKey, out var copy) is { } blocked) return blocked;
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
        var (source, identity, destination, release, _) = copy;
        if (RefuseIfDisallowedForCopyAsNewRecord(identity.RecordType) is { } disallowedRefusal) return disallowedRefusal;

        if (RecordTypeDispatch.For(release).FolderNameFor(identity.RecordType) is null
            && source.ContainerOf(identity) is { } container)
        {
            return CopyEmbeddedChildAsNewRecord(copy, container, destinationPlugin);
        }

        return CopyUnderNextFormKey(
            copy, destinationPlugin,
            duplicate =>
            {
                destination.Repository.Put(destinationPlugin, duplicate);
                return RecordEditResult.Success();
            },
            "new working-tree source document");
    }

    private RecordEditResult CopyEmbeddedChildAsNewRecord(
        WriteTargets.CopyTarget copy, DocumentContainment container, PluginAddress destinationPlugin) =>
        CopyUnderNextFormKey(
            copy, destinationPlugin,
            duplicate => _recordCopy.AppendEmbeddedChild(copy.Source, container, duplicate, copy.Destination, copy.Release),
            $"inside {container.ParentFormKey}'s {container.SlotName} slot");

    private RecordEditResult CopyUnderNextFormKey(
        WriteTargets.CopyTarget copy, PluginAddress destinationPlugin, Func<SourceDocument, RecordEditResult> land, string landedAt)
    {
        var (source, identity, destination, release, body) = copy;
        if (FormKeyAllocator.Over(destination.Repository, destinationPlugin, release).Next(out var targetFormKey)
            is { } refusedTarget) return refusedTarget;

        var named = RecordDocumentEdits.DuplicatedWithoutChildren(
            _codec, body, release, identity.RecordType, targetFormKey,
            EditorIdDeriver(destination.Repository.EditorIdsHeld(destinationPlugin)));
        var landed = land(new SourceDocument(targetFormKey, identity.RecordType, named.EditorId, named.Text));
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
