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
    private readonly ILogger _logger;

    internal OverrideCopy(
        WriteTargets targets,
        RecordCopy recordCopy,
        LoadOrderResolution resolution,
        ILogger logger)
    {
        (_targets, _recordCopy, _resolution, _logger) = (targets, recordCopy, resolution, logger);
    }

    /// <summary>An unreadable source record refuses rather than landing as a stub.
    /// <paramref name="replace"/> lets it take a held record's place.</summary>
    internal SourceAnswer<RecordEditChanges> Copy(
        CopySource source, string formKey, PluginAddress destinationPlugin, bool replace, UnsavedBatches batches)
    {
        if (_targets.ResolveCopySource(destinationPlugin, source, formKey, batches, out var copy) is { } blocked) return blocked;
        // commands.md, Doing nothing is not an error: the record's own plugin already is this copy.
        if (PluginAddress.Comparer.Equals(source.Plugin, destinationPlugin)) return RecordEditResult.Success();
        return RecordCopy.ChangesSince(copy.Batch, copy.Batch.Changes, CopyAsOverride(copy, destinationPlugin, replace));
    }

    private SourceAnswer<RecordEditResult> CopyAsOverride(
        WriteTargets.CopyTarget copy, PluginAddress destinationPlugin, bool replace)
    {
        if (RefuseIfUnderride(copy.Identity, copy.Body, destinationPlugin) is { } underrideRefusal) return underrideRefusal;

        return LandRecord(copy, destinationPlugin, replace);
    }

    private SourceAnswer<RecordEditResult> LandRecord(
        WriteTargets.CopyTarget copy, PluginAddress destinationPlugin, bool replace)
    {
        var (source, identity, destination, _, release, body) = copy;
        var formKey = identity.FormKey;

        if (!destination.Repository.FormKeysUsed(destinationPlugin).Holds(out var used, out var unread)) return unread;
        if (used.Contains(formKey))
        {
            if (!RecordCopy.Identity(destination, formKey).Holds(out var held, out unread)) return unread;
            if (held is not { } existingTarget) return RecordCopy.RefuseKeyWithNoDocument(destination, formKey);
            if (!replace) return RecordCopy.RefuseHeldWithoutReplace(formKey, destinationPlugin);

            // Own fields only, as xEdit's copy-into does: the children the destination's copy
            // carries stay.
            return ReplaceHeldCopy(source, identity, body, existingTarget, destination, release);
        }

        // A record with a container, a worldspace's persistent cell among them, lands in the
        // destination's copy of that container (the container rule).
        if (!source.ContainerOf(identity).Holds(out var container, out var why)) return WriteTargets.RefuseUnreadableSource(formKey, why);
        return container is { } parent
            ? _recordCopy.CopyNewChildAsOverride(
                source, new SourceDocument(formKey, identity.RecordType, identity.EditorId, body), parent, destination, release)
            : LandNewRecord(copy, body, destinationPlugin);
    }

    private SourceAnswer<RecordEditResult> LandNewRecord(
        WriteTargets.CopyTarget copy, string body, PluginAddress destinationPlugin)
    {
        var (source, identity, destination, _, release, _) = copy;
        var formKey = identity.FormKey;
        var worldspaceRead = RecordTypes.For(release).IsCell(identity.RecordType) ? source.WorldspaceOf(identity) : (string?)null;
        if (!worldspaceRead.Holds(out var worldspace, out var why)) return WriteTargets.RefuseUnreadableSource(formKey, why);
        if (worldspace is not null)
        {
            if (!SourceTransaction.Atomically(destination.Repository, transaction => _recordCopy.PlaceExteriorCell(
                    transaction, source, worldspace,
                    new SourceDocument(
                        formKey, identity.RecordType, identity.EditorId,
                        ContainerDocumentEdits.WithoutChildren(body, release, identity.RecordType)),
                    destination, release)).Holds(out var placed, out var unplaced))
            {
                return unplaced;
            }
            if (placed.Applied && _logger.IsEnabled(LogLevel.Information))
            {
                _logger.LogInformation(
                    "Copied {FormKey} from {SourcePlugin} ({SourceOrigin}) as an override into " +
                    "{DestinationPlugin} ({DestinationOrigin}) — copied in its worldspace as an override",
                    formKey, source.Plugin.Name, source.Plugin.Origin, destinationPlugin.Name, destinationPlugin.Origin);
            }
            return placed;
        }

        // Copy as Override is own-fields-only, so a container's children are left out.
        if (RecordTypes.For(release).HasChildSlots(identity.RecordType))
            body = ContainerDocumentEdits.WithoutChildren(body, release, identity.RecordType);

        if (!Put(destination, new SourceDocument(formKey, identity.RecordType, identity.EditorId, body)).Holds(out var put, out var unwritten))
            return unwritten;

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation(
                "Copied {FormKey} from {SourcePlugin} ({SourceOrigin}) as an override into {DestinationPlugin} " +
                "({DestinationOrigin}) — new working-tree source document",
                formKey, source.Plugin.Name, source.Plugin.Origin, destinationPlugin.Name, destinationPlugin.Origin);
        }
        // An override echoes the caller's own FormKey back, so NewFormKey stays null.
        return put;
    }

    private static SourceAnswer<RecordEditResult> Put(RecordCopy.Destination destination, SourceDocument document) =>
        RecordEditResult.Making(
            RecordEditResult.Success(), destination.Repository,
            transaction => transaction.Apply(destination.Repository.ChangesToPut(destination.Plugin, document)));

    private SourceAnswer<RecordEditResult> ReplaceHeldCopy(
        CopySource source, RecordIdentity identity, string body, RecordIdentity existingTarget,
        RecordCopy.Destination destination, GameRelease release)
    {
        if (!destination.Repository.RecordOf(destination.Plugin, existingTarget).Holds(out var held, out var unread)) return unread;
        var existing = held
            ?? throw RecordCopy.NoDocumentCarries(destination.Plugin, identity.FormKey);

        var replacement = ContainerDocumentEdits.WithOwnFieldsReplaced(
            existing.Body, existing.RecordType, body, identity.RecordType, release);

        if (!Put(destination, new SourceDocument(identity.FormKey, existingTarget.RecordType, replacement.EditorId, replacement.Text))
                .Holds(out var put, out var unwritten))
        {
            return unwritten;
        }

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation(
                "Copied {FormKey} from {SourcePlugin} ({SourceOrigin}) as an override into {DestinationPlugin} " +
                "({DestinationOrigin}) — replaced the copy it held, own fields only",
                identity.FormKey, source.Plugin.Name, source.Plugin.Origin, destination.Plugin.Name,
                destination.Plugin.Origin);
        }
        return put;
    }

    // A plugin the load order does not place passes.
    private RecordEditResult? RefuseIfUnderride(RecordIdentity identity, string body, PluginAddress destinationPlugin) =>
        _resolution.MasterLoadingAfter(identity, body, destinationPlugin) is { } master
            ? RecordEditResult.Refused(
                RecordEditRefusal.UnderrideDestination,
                $"{destinationPlugin.Name} loads before {master}, a master the copy of {identity.FormKey} needs — copying it " +
                $"there would be an underride, not an override. Pick a destination that loads after {master}.")
            : null;
}
