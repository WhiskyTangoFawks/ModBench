using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Serialization;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Commands;

/// <summary>The Copy as New Record gesture's handler (ADR-0046 invariant 3): xEdit's "Copy as New
/// Record Into…" — a Mutagen <c>Duplicate</c> under a freshly allocated FormKey (ADR-0041).</summary>
public sealed class CopyRecordAsNewRecordHandler
{
    private readonly WriteTargets _targets;
    private readonly RecordCopy _recordCopy;
    private readonly RecordTextCodec _codec;
    private readonly ILogger<CopyRecordAsNewRecordHandler> _logger;

    // Internal because the shared module is, which is why this assembly registers its own handlers
    // (MEditService.Core.Composition) rather than the host naming a type it cannot see.
    internal CopyRecordAsNewRecordHandler(
        WriteTargets targets,
        RecordCopy recordCopy,
        RecordTextCodec codec,
        ILogger<CopyRecordAsNewRecordHandler> logger)
    {
        (_targets, _recordCopy, _codec, _logger) = (targets, recordCopy, codec, logger);
    }

    /// <summary>The fresh FormKey comes from the same allocator create draws on. A self-link is
    /// remapped onto it, as xEdit does.</summary>
    public RecordEditResult CopyRecordAsNewRecord(
        PluginKey sourcePlugin, string formKey, PluginKey destinationPlugin, string? requestedFormKey = null)
    {
        if (_targets.ResolveCopySource(destinationPlugin, sourcePlugin, formKey, out var copy) is { } blocked) return blocked;
        using var source = copy.Source;
        return CopyAsNewRecord(copy, destinationPlugin, requestedFormKey);
    }

    private RecordEditResult CopyAsNewRecord(
        WriteTargets.CopyTarget copy, PluginKey destinationPlugin, string? requestedFormKey)
    {
        var (source, identity, destination, release, _) = copy;
        var formKey = identity.FormKey;
        if (RefuseIfDisallowedForCopyAsNewRecord(identity.RecordType) is { } disallowedRefusal) return disallowedRefusal;

        // A record with no group of its own copies into its container's document (a topic into its
        // quest, a response into its topic); a placed reference has no such container and refuses.
        if (RecordTypeDispatch.For(release).FolderNameFor(identity.RecordType) is null)
        {
            if (source.ContainerOf(identity) is { } container)
                return CopyEmbeddedChildAsNewRecord(copy, container, destinationPlugin, requestedFormKey);
            if (WriteTargets.RefuseIfContainerType(identity.RecordType, release) is { } containerRefusal) return containerRefusal;
        }

        if (_targets.ResolveTargetFormKey(
                destination.Repository, destinationPlugin, requestedFormKey, out var targetFormKey)
            is { } refusedTarget) return refusedTarget;

        var newRecord = source.Record(identity).Duplicate(FormKey.Factory(targetFormKey));
        RemapSelfLink(newRecord, formKey, targetFormKey);

        // Own-record-only, like Copy as Override: a container's children never ride along (deep copy
        // is a separate operation).
        ContainerChildFields.ClearAllChildSlots(newRecord);
        var placement = SourceRepository.PlacementFor(
            destinationPlugin.Name, identity.RecordType, targetFormKey, newRecord.EditorID, release);
        RecordEditService.WriteAt(
            destination.ModFolder, placement,
            path => RecordEditService.SerializeAndWrite(_codec, newRecord, path, release));

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation(
                "Copied {FormKey} from {SourcePlugin} ({SourceOrigin}) as new record {NewFormKey} into " +
                "{DestinationPlugin} ({DestinationOrigin}) — new working-tree source file at {SourcePath}",
                formKey, source.Plugin.Name, source.Plugin.Origin, targetFormKey, destinationPlugin.Name,
                destinationPlugin.Origin, placement.RelativePath);
        }
        return RecordEditResult.Success(targetFormKey);
    }

    // The embedded subtree rides along, each record under a fresh key drawn before anything is written.
    // Links between copied siblings are not remapped, xEdit's own behavior. A missing container chain
    // auto-creates bare and Partial Form.
    private RecordEditResult CopyEmbeddedChildAsNewRecord(
        WriteTargets.CopyTarget copy, CopySource.Containment container, PluginKey destinationPlugin, string? requestedFormKey)
    {
        var (source, identity, destination, release, _) = copy;

        var allocator = _targets.AllocatorOver(destination.Repository, destinationPlugin);
        if (WriteTargets.ResolveTargetFormKey(allocator, requestedFormKey, out var targetFormKey) is { } refusedTarget)
            return refusedTarget;

        // Its own text carries its whole embedded subtree, so the codec has already read every
        // descendant by the time one can be re-keyed.
        var newRecord = source.Record(identity).Duplicate(FormKey.Factory(targetFormKey));
        RemapSelfLink(newRecord, identity.FormKey, targetFormKey);

        var taken = new HashSet<string>(StringComparer.Ordinal) { targetFormKey };
        if (RekeyEmbeddedDescendants(allocator, newRecord, taken) is { } childRefused) return childRefused;

        var appended = _recordCopy.AppendEmbeddedChild(
            source, container.ParentFormKey, container.ParentRecordType, container.SlotName, newRecord,
            destination, release);
        if (!appended.Applied) return appended;

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation(
                "Copied {FormKey} from {SourcePlugin} ({SourceOrigin}) as new record {NewFormKey} into " +
                "{DestinationPlugin} ({DestinationOrigin}) — inside {ContainerFormKey}'s {SlotName} slot, " +
                "with {DescendantCount} embedded descendant(s) each under a fresh FormKey",
                identity.FormKey, source.Plugin.Name, source.Plugin.Origin, targetFormKey, destinationPlugin.Name,
                destinationPlugin.Origin, container.ParentFormKey, container.SlotName, taken.Count - 1);
        }
        return RecordEditResult.Success(targetFormKey);
    }

    // In place, on the duplicate's own graph: the list order is untouched, and a child's own
    // embedded children are re-keyed the same way one level down.
    private static RecordEditResult? RekeyEmbeddedDescendants(
        WriteTargets.Allocator allocator, IMajorRecordGetter container, HashSet<string> taken)
    {
        var containerType = ContainerChildFields.NormalizedTypeName(container.GetType());
        foreach (var (slotName, _, child) in ContainerChildFields.EnumerateChildren(container).ToList())
        {
            if (!ContainerChildFields.EmbeddedSlots.Contains((containerType, slotName))) continue;
            if (WriteTargets.ResolveTargetFormKey(allocator, requestedFormKey: null, out var childFormKey, taken) is { } refused)
                return refused;
            taken.Add(childFormKey);

            var oldFormKey = child.FormKey.ToString();
            ((IMajorRecordInternal)child).FormKey = FormKey.Factory(childFormKey);
            RemapSelfLink(child, oldFormKey, childFormKey);
            if (RekeyEmbeddedDescendants(allocator, child, taken) is { } deeper) return deeper;
        }
        return null;
    }

    private static void RemapSelfLink(IMajorRecordGetter record, string oldFormKey, string newFormKey)
    {
        if (record is IFormLinkContainer links)
            links.RemapLinks(new Dictionary<FormKey, FormKey> { [FormKey.Factory(oldFormKey)] = FormKey.Factory(newFormKey) });
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
