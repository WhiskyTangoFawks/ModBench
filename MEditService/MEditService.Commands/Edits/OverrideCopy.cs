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

    /// <summary>An unreadable source record refuses rather than landing as a stub.
    /// <paramref name="replace"/> lets it take a held record's place; <paramref name="deep"/> brings
    /// the child records, and a record with none is a plain override.</summary>
    internal RecordEditResult Copy(
        PluginAddress sourcePlugin, string formKey, PluginAddress destinationPlugin, bool replace, bool deep = false)
    {
        if (_targets.ResolveCopySource(destinationPlugin, sourcePlugin, formKey, out var copy) is { } blocked) return blocked;
        using var source = copy.Source;
        // commands.md, Doing nothing is not an error: the record's own plugin already is this copy.
        if (PluginAddress.Comparer.Equals(sourcePlugin, destinationPlugin)) return RecordEditResult.Success();
        try
        {
            return CopyAsOverride(copy, destinationPlugin, replace, deep);
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
        WriteTargets.CopyTarget copy, PluginAddress destinationPlugin, bool replace, bool deep)
    {
        var (source, identity, destination, release, body) = copy;
        var formKey = identity.FormKey;
        if (RefuseIfUnderride(formKey, destinationPlugin) is { } underrideRefusal) return underrideRefusal;

        var cells = deep ? WorldspaceCellsOf(copy) : new WorldspaceCells([], []);
        var childKeys = deep ? ChildKeysOf(copy, cells) : [];
        var withChildren = childKeys.Count > 0;
        if (withChildren)
        {
            if (RefuseIfAnyChildIsAnUnderride(childKeys, destinationPlugin) is { } childUnderride) return childUnderride;
            if (!replace && RecordCopy.RefuseIfHoldsChildRecords(destination, formKey, childKeys) is { } held) return held;
        }

        // A record a container's document carries, a worldspace's persistent cell among them, lands
        // inside the destination's copy of that document (the container rule).
        if (source.ContainerOf(identity) is { } container)
        {
            return _recordCopy.CopyEmbeddedChildAsOverride(
                source, new SourceDocument(formKey, identity.RecordType, identity.EditorId, body),
                container, destination, release, replace, withChildren);
        }

        if (RefuseIfCopySourceHasNoContainerOfItsOwn(identity.RecordType, release) is { } containerRefusal)
            return containerRefusal;

        var landed = LandRecord(copy, destinationPlugin, replace, withChildren);
        return landed.Applied && cells.Numbered.Count > 0 ? LandCells(copy, cells) : landed;
    }

    // Every child record at any depth, a worldspace's numbered cells and what they carry included.
    private List<string> ChildKeysOf(WriteTargets.CopyTarget copy, WorldspaceCells cells)
    {
        var (source, identity, _, release, body) = copy;
        var keys = ContainerDocumentEdits.ChildFormKeys(_codec, body, release, identity.RecordType).ToList();
        foreach (var cell in cells.Numbered)
        {
            keys.Add(cell);
            var cellDocument = source.Document(CellIdentity(source, cell));
            keys.AddRange(ContainerDocumentEdits.ChildFormKeys(_codec, cellDocument.Body, release, cellDocument.RecordType));
        }
        return keys;
    }

    private static RecordIdentity CellIdentity(CopySource source, string cell) =>
        source.Identity(cell)
        ?? throw new InvalidOperationException($"{source.Plugin.Name} does not hold {cell} — its own worldspace named it.");

    // The origin of each child record is a plugin the destination must load after.
    private RecordEditResult? RefuseIfAnyChildIsAnUnderride(IEnumerable<string> childKeys, PluginAddress destinationPlugin) =>
        childKeys
            .DistinctBy(key => FormKey.Factory(key).ModKey)
            .Select(key => RefuseIfUnderride(key, destinationPlugin))
            .FirstOrDefault(refusal => refusal is not null);

    // The persistent cell is in the worldspace's own document; every other cell has one of its own.
    private readonly record struct WorldspaceCells(IReadOnlyList<string> Persistent, IReadOnlyList<string> Numbered);

    private WorldspaceCells WorldspaceCellsOf(WriteTargets.CopyTarget copy)
    {
        var (source, identity, _, release, body) = copy;
        if (!RecordTypeDispatch.For(release).IsWorldspace(identity.RecordType)) return new WorldspaceCells([], []);

        var embedded = ContainerDocumentEdits.ChildFormKeys(_codec, body, release, identity.RecordType).ToHashSet();
        var cells = source.CellsIn(identity.FormKey).ToLookup(embedded.Contains);
        return new WorldspaceCells([.. cells[true]], [.. cells[false].Order(StringComparer.Ordinal)]);
    }

    // A failure leaves the cells before it in the working tree, and the answer names them. Only a
    // fault of the tree, the file system or a slot another record holds is that answer.
    private RecordEditResult LandCells(WriteTargets.CopyTarget copy, WorldspaceCells cells)
    {
        var (source, identity, destination, release, _) = copy;
        var landed = new List<string>(cells.Persistent);
        var held = destination.Repository.FormKeysUsed(destination.Plugin);
        foreach (var cell in cells.Numbered)
        {
            try
            {
                var document = source.Document(CellIdentity(source, cell));
                if (held.Contains(cell)) _recordCopy.OverwriteHeldCell(document, destination, release);
                else
                {
                    _recordCopy.RemoveChildrenHeldElsewhere(destination, document.Body, document.RecordType, null, release);
                    _recordCopy.PutExteriorCell(identity.FormKey, document, document.Body, destination, release);
                }
                landed.Add(cell);
            }
            catch (Exception ex) when (ex is AmbiguousSourceUnitException or UnreadableSourceDocumentException
                                           or ChildSlotHeldByAnotherRecordException or IOException or UnauthorizedAccessException)
            {
                _logger.LogError(ex, "A deep copy of {FormKey} stopped at {Cell}", identity.FormKey, cell);
                return RecordEditResult.Refused(
                    ex switch
                    {
                        AmbiguousSourceUnitException => RecordEditRefusal.AmbiguousSourceUnit,
                        UnreadableSourceDocumentException => RecordEditRefusal.RecordParseFailed,
                        ChildSlotHeldByAnotherRecordException => RecordEditRefusal.ChildSlotHeldByAnotherRecord,
                        _ => RecordEditRefusal.SourceWriteFailed,
                    },
                    $"{identity.FormKey} landed in {destination.Plugin.Name} ({destination.Plugin.Origin}) only in part, " +
                    $"and nothing was rolled back. The cells that landed: {(landed.Count == 0 ? "none" : string.Join(", ", landed))}. " +
                    $"The cell that failed: {cell}: {ex.Message} Discard the working-tree changes to undo it.");
            }
        }
        return RecordEditResult.Success();
    }

    private RecordEditResult LandRecord(
        WriteTargets.CopyTarget copy, PluginAddress destinationPlugin, bool replace, bool withChildren)
    {
        var (source, identity, destination, release, body) = copy;
        var formKey = identity.FormKey;

        if (destination.Repository.FormKeysUsed(destinationPlugin).Contains(formKey))
        {
            if (_recordCopy.Identity(destination, formKey, release) is not { } existingTarget)
                return RecordCopy.RefuseKeyWithNoDocument(destination, formKey);
            if (withChildren)
                return _recordCopy.MergeChildrenIntoHeldCopy(source.Plugin, existingTarget, body, identity.RecordType, destination, release);
            if (!replace) return RecordCopy.RefuseHeldWithoutReplace(formKey, destinationPlugin);

            // Own fields only, as xEdit's copy-into does: the children the destination's copy
            // carries stay.
            return ReplaceHeldCopy(source, identity, body, existingTarget, destination, release);
        }

        if (withChildren) _recordCopy.RemoveChildrenHeldElsewhere(destination, body, identity.RecordType, null, release);

        var isCell = RecordTypeDispatch.For(release).IsCell(identity.RecordType);
        if (isCell && source.WorldspaceOf(identity) is { } worldspace)
        {
            var placed = _recordCopy.PlaceExteriorCell(
                source, worldspace,
                new SourceDocument(
                    formKey, identity.RecordType, identity.EditorId,
                    withChildren ? body : StripEmbeddedChildrenForShallowCopy(body, identity.RecordType, release)),
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
        if (!withChildren && ContainerChildFields.HasChildFields(identity.RecordType, release))
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
