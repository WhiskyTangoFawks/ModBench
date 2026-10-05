using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Edits;

/// <summary>Copy's override mode, one record into one destination: xEdit's "Copy as Override
/// Into…": the source's own bytes land verbatim under the same FormKey.</summary>
internal sealed class OverrideCopy
{
    private readonly WriteTargets _targets;
    private readonly RecordCopy _recordCopy;
    private readonly LoadOrderHolder _loadOrder;
    private readonly RecordTextCodec _codec;
    private readonly ILogger _logger;

    internal OverrideCopy(
        WriteTargets targets,
        RecordCopy recordCopy,
        LoadOrderHolder loadOrder,
        RecordTextCodec codec,
        ILogger logger)
    {
        (_targets, _recordCopy, _loadOrder, _codec, _logger) = (targets, recordCopy, loadOrder, codec, logger);
    }

    /// <summary>The source's text is read before anything is written, so a record the codec cannot
    /// read refuses rather than landing as a stub. A destination holding the record takes it only
    /// with <paramref name="replace"/>.</summary>
    internal RecordEditResult Copy(PluginAddress sourcePlugin, string formKey, PluginAddress destinationPlugin, bool replace)
    {
        if (_targets.ResolveCopySource(destinationPlugin, sourcePlugin, formKey, out var copy) is { } blocked) return blocked;
        using var source = copy.Source;
        // commands.md, Doing nothing is not an error: the record's own plugin already is this copy.
        if (PluginAddress.Comparer.Equals(sourcePlugin, destinationPlugin)) return RecordEditResult.Success();
        try
        {
            return CopyAsOverride(copy, destinationPlugin, replace);
        }
        catch (UnreadableSourceDocumentException ex)
        {
            return WriteTargets.RefuseUnreadableSourceTree(formKey, ex.Message);
        }
    }

    private RecordEditResult CopyAsOverride(WriteTargets.CopyTarget copy, PluginAddress destinationPlugin, bool replace)
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

        if (RefuseIfCopySourceHasNoContainerOfItsOwn(identity.RecordType, release) is { } containerRefusal)
            return containerRefusal;

        if (destination.Repository.FormKeysUsed(destinationPlugin).Contains(formKey))
        {
            if (_recordCopy.Identity(destination, formKey, release) is not { } existingTarget)
                return RecordCopy.RefuseKeyWithNoDocument(destination, formKey);
            if (!replace) return RecordCopy.RefuseHeldWithoutReplace(formKey, destinationPlugin);

            // Own fields only, as xEdit's copy-into does: the children the destination's copy
            // carries stay.
            return ReplaceHeldCopy(source, identity, body, existingTarget, destination, release);
        }

        var isCell = RecordTypeDispatch.For(release).IsCell(identity.RecordType);
        if (isCell && source.WorldspaceOf(identity) is { } worldspace)
        {
            var placed = _recordCopy.PlaceExteriorCell(
                source, worldspace,
                new SourceDocument(
                    formKey, identity.RecordType, identity.EditorId,
                    StripEmbeddedChildrenForShallowCopy(body, identity.RecordType, release)),
                destination, release);
            if (placed.Applied && _logger.IsEnabled(LogLevel.Information))
            {
                _logger.LogInformation(
                    "Copied {FormKey} from {SourcePlugin} ({SourceOrigin}) as an override into " +
                    "{DestinationPlugin} ({DestinationOrigin}) — copied in its worldspace as an override",
                    formKey, source.Plugin.Name, source.Plugin.Origin, destinationPlugin.Name, destinationPlugin.Origin);
            }
            return placed;
        }

        // A plain Copy as Override is own-fields-only, so a container's inline children are stripped.
        if (ContainerChildFields.HasChildFields(identity.RecordType, release))
            body = StripEmbeddedChildrenForShallowCopy(body, identity.RecordType, release);

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

    // A destination loading before the origin would be an underride, silently
    // beaten at runtime. A plugin the load order does not place passes.
    private RecordEditResult? RefuseIfUnderride(string formKey, PluginAddress destinationPlugin)
    {
        var loadOrder = _loadOrder.Current;

        // A FormKey carries only a filename, so with two plugins that share a filename (ADR-0012) the
        // active one is the origin.
        var originName = FormKey.Factory(formKey).ModKey.FileName.String;
        var origin = loadOrder.Active.FirstOrDefault(p => p.Name.Equals(originName, StringComparison.OrdinalIgnoreCase));
        var originIndex = origin is null ? null : loadOrder.LoadOrderIndex(origin.Key);
        var destinationIndex = loadOrder.LoadOrderIndex(destinationPlugin);
        if (originIndex is not { } originAt || destinationIndex is not { } destinationAt || destinationAt >= originAt)
            return null;

        return RecordEditResult.Refused(
            RecordEditRefusal.UnderrideDestination,
            $"{destinationPlugin.Name} loads before {originName}, which originates {formKey} — copying it " +
            "there would be an underride, not an override: the origin's copy would still win at runtime. " +
            "Pick a destination that loads after the origin.");
    }

    // Narrower than RefuseIfContainerType: a container's own top-level record has a directory to
    // land in, so only a record with no container of its own anywhere in the tree refuses.
    private static RecordEditResult? RefuseIfCopySourceHasNoContainerOfItsOwn(string recordType, GameRelease release)
    {
        if (RecordTypeDispatch.For(release).GroupFolderNameFor(recordType) is not null) return null;

        return RecordEditResult.Refused(
            RecordEditRefusal.ContainerRecordNotYetSupported,
            $"'{recordType}' lives inside a container's document (a dialog topic, a scene), and no readable " +
            "container document in the source plugin carries this record.");
    }

    private string StripEmbeddedChildrenForShallowCopy(string body, string recordType, GameRelease release) =>
        ContainerDocumentEdits.WithoutChildren(_codec, body, release, recordType);
}
