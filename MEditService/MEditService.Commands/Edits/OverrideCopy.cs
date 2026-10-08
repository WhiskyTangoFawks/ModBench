using MEditService.Codec.Serialization;
using MEditService.Commands.Resolution;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Commands.Edits;

/// <summary>Copy's override mode, one record into one destination: xEdit's "Copy as Override
/// Into…": the source's own bytes land verbatim under the same FormKey.</summary>
internal sealed class OverrideCopy
{
    private readonly WriteTargets _targets;
    private readonly RecordCopy _recordCopy;
    private readonly LoadOrderResolution _resolution;
    private readonly RecordTextCodec _codec;
    private readonly ILogger _logger;

    internal OverrideCopy(
        WriteTargets targets,
        RecordCopy recordCopy,
        LoadOrderResolution resolution,
        RecordTextCodec codec,
        ILogger logger)
    {
        (_targets, _recordCopy, _resolution, _codec, _logger) = (targets, recordCopy, resolution, codec, logger);
    }

    /// <summary>An unreadable source record refuses rather than landing as a stub.
    /// <paramref name="replace"/> lets it take a held record's place.</summary>
    internal RecordEditResult Copy(
        CopySource source, string formKey, PluginAddress destinationPlugin, bool replace)
    {
        if (_targets.ResolveCopySource(destinationPlugin, source, formKey, out var copy) is { } blocked) return blocked;
        // commands.md, Doing nothing is not an error: the record's own plugin already is this copy.
        if (PluginAddress.Comparer.Equals(source.Plugin, destinationPlugin)) return RecordEditResult.Success();
        try
        {
            return CopyAsOverride(copy, destinationPlugin, replace);
        }
        catch (UnreadableSourceDocumentException ex)
        {
            return WriteTargets.RefuseUnreadableSourceTree(formKey, ex.Message);
        }
        catch (ChildSlotHeldByAnotherRecordException ex)
        {
            return RefuseSlotHeldByAnotherRecord(destinationPlugin, ex);
        }
    }

    private static RecordEditResult RefuseSlotHeldByAnotherRecord(PluginAddress destinationPlugin, ChildSlotHeldByAnotherRecordException ex) =>
        RecordEditResult.Refused(
            RecordEditRefusal.ChildSlotHeldByAnotherRecord,
            $"{destinationPlugin.Name} ({destinationPlugin.Origin}) holds another record where the copy puts one: {ex.Message}");

    private RecordEditResult CopyAsOverride(
        WriteTargets.CopyTarget copy, PluginAddress destinationPlugin, bool replace)
    {
        var (source, identity, destination, release, body) = copy;
        var formKey = identity.FormKey;
        if (RefuseIfUnderride(formKey, destinationPlugin) is { } underrideRefusal) return underrideRefusal;

        // A record a container's document carries, a worldspace's persistent cell among them, lands
        // inside the destination's copy of that document (the container rule).
        if (source.ContainerOf(identity) is { } container)
        {
            return _recordCopy.CopyEmbeddedChildAsOverride(
                source, new SourceDocument(formKey, identity.RecordType, identity.EditorId, body),
                container, destination, release, replace);
        }

        return LandRecord(copy, destinationPlugin, replace);
    }

    private RecordEditResult LandRecord(
        WriteTargets.CopyTarget copy, PluginAddress destinationPlugin, bool replace)
    {
        var (source, identity, destination, release, body) = copy;
        var formKey = identity.FormKey;

        if (destination.Repository.FormKeysUsed(destinationPlugin).Contains(formKey))
        {
            if (_recordCopy.Identity(destination, formKey, release) is not { } existingTarget)
                return RecordCopy.RefuseKeyWithNoDocument(destination, formKey);
            if (!replace) return RecordCopy.RefuseHeldWithoutReplace(formKey, destinationPlugin);

            // Own fields only, as xEdit's copy-into does: the children the destination's copy
            // carries stay.
            return ReplaceHeldCopy(source, identity, body, existingTarget, destination, release);
        }

        return LandNewRecord(copy, body, destinationPlugin);
    }

    private RecordEditResult LandNewRecord(
        WriteTargets.CopyTarget copy, string body, PluginAddress destinationPlugin)
    {
        var (source, identity, destination, release, _) = copy;
        var formKey = identity.FormKey;
        var isCell = RecordTypeDispatch.For(release).IsCell(identity.RecordType);
        if (isCell && source.WorldspaceOf(identity) is { } worldspace)
        {
            var placed = SourceTransaction.Atomically(destination.Repository, transaction => _recordCopy.PlaceExteriorCell(
                transaction, source, worldspace,
                new SourceDocument(
                    formKey, identity.RecordType, identity.EditorId,
                    StripEmbeddedChildren(body, identity.RecordType, release)),
                destination, release));
            if (placed.Applied && _logger.IsEnabled(LogLevel.Information))
            {
                _logger.LogInformation(
                    "Copied {FormKey} from {SourcePlugin} ({SourceOrigin}) as an override into " +
                    "{DestinationPlugin} ({DestinationOrigin}) — copied in its worldspace as an override",
                    formKey, source.Plugin.Name, source.Plugin.Origin, destinationPlugin.Name, destinationPlugin.Origin);
            }
            return placed;
        }

        // Copy as Override is own-fields-only, so a container's inline children are stripped.
        if (ContainerChildFields.HasChildFields(identity.RecordType, release))
            body = StripEmbeddedChildren(body, identity.RecordType, release);

        destination.Repository.Put(
            destinationPlugin, new SourceDocument(formKey, identity.RecordType, identity.EditorId, body));

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation(
                "Copied {FormKey} from {SourcePlugin} ({SourceOrigin}) as an override into {DestinationPlugin} " +
                "({DestinationOrigin}) — new working-tree source document",
                formKey, source.Plugin.Name, source.Plugin.Origin, destinationPlugin.Name, destinationPlugin.Origin);
        }
        // An override echoes the caller's own FormKey back, so NewFormKey stays null.
        return RecordEditResult.Success();
    }

    // The destination's embedded children are transplanted onto the replacing record so the copy
    // cannot delete them.
    private RecordEditResult ReplaceHeldCopy(
        CopySource source, RecordIdentity identity, string body, RecordIdentity existingTarget,
        RecordCopy.Destination destination, GameRelease release)
    {
        var existing = destination.Repository.Get(destination.Plugin, existingTarget)
            ?? throw new InvalidOperationException(
                $"{destination.Plugin.Name} holds {identity.FormKey}, but no document in its source tree carries it.");

        var replacement = ContainerDocumentEdits.WithOwnFieldsReplaced(
            _codec, existing.Body, existing.RecordType, body, identity.RecordType, release);

        destination.Repository.Put(
            destination.Plugin,
            new SourceDocument(
                identity.FormKey, existingTarget.RecordType, replacement.EditorId, replacement.Text));

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation(
                "Copied {FormKey} from {SourcePlugin} ({SourceOrigin}) as an override into {DestinationPlugin} " +
                "({DestinationOrigin}) — replaced the copy it held, own fields only",
                identity.FormKey, source.Plugin.Name, source.Plugin.Origin, destination.Plugin.Name,
                destination.Plugin.Origin);
        }
        return RecordEditResult.Success();
    }

    // A plugin the load order does not place passes.
    private RecordEditResult? RefuseIfUnderride(string formKey, PluginAddress destinationPlugin) =>
        _resolution.OriginLoadingAfter(formKey, destinationPlugin) is { } originName
            ? RecordEditResult.Refused(
                RecordEditRefusal.UnderrideDestination,
                $"{destinationPlugin.Name} loads before {originName}, which originates {formKey} — copying it " +
                "there would be an underride, not an override: the origin's copy would still win at runtime. " +
                "Pick a destination that loads after the origin.")
            : null;

    private string StripEmbeddedChildren(string body, string recordType, GameRelease release) =>
        ContainerDocumentEdits.WithoutChildren(_codec, body, release, recordType);
}
