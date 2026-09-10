using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Serialization;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Commands;

/// <summary>The Copy as Override gesture's handler (ADR-0046 invariant 3): xEdit's "Copy as
/// Override Into…" — the source's own bytes land verbatim under the same FormKey (ADR-0041).</summary>
public sealed class CopyRecordAsOverrideHandler
{
    private readonly WriteTargets _targets;
    private readonly RecordCopy _recordCopy;
    private readonly LoadOrderHolder _loadOrder;
    private readonly RecordTextCodec _codec;
    private readonly ILogger<CopyRecordAsOverrideHandler> _logger;

    // Internal because the shared module is, which is why this assembly registers its own handlers
    // (MEditService.Core.Composition) rather than the host naming a type it cannot see.
    internal CopyRecordAsOverrideHandler(
        WriteTargets targets,
        RecordCopy recordCopy,
        LoadOrderHolder loadOrder,
        RecordTextCodec codec,
        ILogger<CopyRecordAsOverrideHandler> logger)
    {
        (_targets, _recordCopy, _loadOrder, _codec, _logger) = (targets, recordCopy, loadOrder, codec, logger);
    }

    /// <summary>The source's text is read before anything is written, so a record the codec cannot
    /// read refuses rather than landing as a stub. The master dependency follows at compile.</summary>
    public RecordEditResult CopyRecordAsOverride(PluginKey sourcePlugin, string formKey, PluginKey destinationPlugin)
    {
        if (_targets.ResolveCopySource(destinationPlugin, sourcePlugin, formKey, out var copy) is { } blocked) return blocked;
        using var source = copy.Source;
        return CopyAsOverride(copy, destinationPlugin);
    }

    private RecordEditResult CopyAsOverride(WriteTargets.CopyTarget copy, PluginKey destinationPlugin)
    {
        var (source, identity, destination, release, body) = copy;
        var formKey = identity.FormKey;
        if (RefuseIfUnderride(formKey, destinationPlugin) is { } underrideRefusal) return underrideRefusal;

        // A record a container's document carries lands inside the destination's copy of that
        // document (the container rule); the refusal below is for a record with no group of its own
        // that no container document carries.
        if (RecordTypeDispatch.For(release).GroupFolderNameFor(identity.RecordType) is null
            && source.ContainerOf(identity) is { } container)
        {
            return _recordCopy.CopyEmbeddedChildAsOverride(
                source, formKey, source.Record(identity), container, destination, release);
        }

        if (RefuseIfCopySourceHasNoContainerOfItsOwn(identity.RecordType, release) is { } containerRefusal)
            return containerRefusal;

        var isContainer = ContainerChildFields.HasChildFields(identity.RecordType, release);
        if (destination.Repository.HoldsAtEitherRef(destinationPlugin, formKey))
        {
            // A destination already overriding the explicitly-selected container record gets it
            // replaced, own-fields-only (xEdit's copy-into behavior). Every other record still
            // refuses, as does a record held only at Head.
            if (isContainer && _recordCopy.Identity(destination, formKey, release) is { } existingTarget)
                return ReplaceExplicitContainerCopyTarget(source, identity, existingTarget, destination, release);

            return RecordEditResult.Refused(
                RecordEditRefusal.FormKeyCollision,
                $"{formKey} is already held by a record in {destinationPlugin.Name} at some ref.");
        }

        // IsInterior is false for both a genuine SubCells cell and a Worldspace's TopCell
        // (PlacementWalker hardcodes it). Only the SubCells case has block coordinates to mint from; a
        // TopCell falls through to the refusal, its placement being a follow-up.
        var isCell = RecordTypeDispatch.For(release).IsCell(identity.RecordType);
        var placement = isCell ? source.CellPlacementOf(identity) : null;
        if (isCell && placement?.IsInterior == false && placement.Value.BlockX != null)
        {
            var cellRecord = source.Record(identity);
            ContainerChildFields.ClearAllChildSlots(cellRecord);
            var mintResult = _recordCopy.MintExteriorCell(
                source, formKey, placement.Value, cellRecord, destination, release);
            if (mintResult.Applied && _logger.IsEnabled(LogLevel.Information))
            {
                _logger.LogInformation(
                    "Copied {FormKey} from {SourcePlugin} ({SourceOrigin}) as an override into " +
                    "{DestinationPlugin} ({DestinationOrigin}) — minted its worldspace as a Partial Form ancestor",
                    formKey, source.Plugin.Name, source.Plugin.Origin, destinationPlugin.Name, destinationPlugin.Origin);
            }
            return mintResult;
        }
        if (isCell && placement?.IsInterior != true)
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.ContainerParentMissingInDestination,
                $"{formKey} is an exterior cell with no worldspace grid position of its own — a worldspace's " +
                $"persistent cell, not one of its numbered blocks — so Copy as Override cannot create it in " +
                $"{destinationPlugin.Name}.");
        }

        // A plain Copy as Override is own-fields-only, so a container's inline children are stripped.
        if (isContainer) body = StripEmbeddedChildrenForShallowCopy(body, identity.RecordType, release);

        // A Cell's block bucket is the one thing resolved first, because it is chosen (or minted)
        // rather than derived.
        var written = SourceRepository.PlacementFor(
            destinationPlugin.Name, identity.RecordType, formKey, identity.EditorId, release,
            isCell
                ? SourceRepository.EnsureInteriorCellBlockPath(destination.ModFolder, destinationPlugin.Name, release)
                : null);
        SourceRepository.WriteAt(destination.ModFolder, written, path =>
        {
            SourceRepository.WriteTextAtomic(path, body);
            return body;
        });

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation(
                "Copied {FormKey} from {SourcePlugin} ({SourceOrigin}) as an override into {DestinationPlugin} " +
                "({DestinationOrigin}) — new working-tree source file at {SourcePath}",
                formKey, source.Plugin.Name, source.Plugin.Origin, destinationPlugin.Name, destinationPlugin.Origin,
                written.RelativePath);
        }
        // An override echoes the caller's own FormKey back, so NewFormKey stays null.
        return RecordEditResult.Success();
    }

    // The destination's embedded children are transplanted onto the replacing record so the copy
    // cannot delete them. An EditorID difference renames the unit, since the round-trip gate
    // regenerates canonical names.
    private RecordEditResult ReplaceExplicitContainerCopyTarget(
        CopySource source, RecordIdentity identity, RecordIdentity existingTarget,
        RecordCopy.Destination destination, GameRelease release)
    {
        var unit = destination.Repository.Locate(destination.Plugin, existingTarget)
            ?? throw new InvalidOperationException(
                $"{destination.Plugin.Name} holds {identity.FormKey}, but no document in its source tree carries it.");

        var replacement = source.Record(identity);
        ContainerChildFields.ClearAllChildSlots(replacement);
        var destinationRecord = _codec
            .DeserializeAsync(unit.FullPath, release, unit.OwnerRecordType).GetAwaiter().GetResult();
        ContainerChildFields.TransplantChildSlots(destinationRecord, replacement);

        // Move first, then write: a crash between leaves the leaf at its new name with old content,
        // still findable by FormKey. The reverse order leaves two units claiming one FormKey.
        _targets.RenameTo(destination.Repository, destination.Plugin, existingTarget, replacement.EditorID);
        destination.Repository.Put(
            destination.Plugin,
            new SourceDocument(
                identity.FormKey, existingTarget.RecordType, replacement.EditorID, _codec.SerializeToText(replacement, release)));

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation(
                "Copied {FormKey} from {SourcePlugin} ({SourceOrigin}) as an override into {DestinationPlugin} " +
                "({DestinationOrigin}) — replaced the existing override's own fields in place",
                identity.FormKey, source.Plugin.Name, source.Plugin.Origin, destination.Plugin.Name,
                destination.Plugin.Origin);
        }
        return RecordEditResult.Success();
    }

    // A destination loading before the origin would be an underride, silently
    // beaten at runtime. A plugin the load order does not place passes.
    private RecordEditResult? RefuseIfUnderride(string formKey, PluginKey destinationPlugin)
    {
        var copies = _loadOrder.Current.Copies;

        // A FormKey carries only a filename, so with two same-named copies (ADR-0036) the winning one
        // is the origin.
        var originName = FormKey.Factory(formKey).ModKey.FileName.String;
        var sameNamed = copies.Where(p => p.Name.Equals(originName, StringComparison.OrdinalIgnoreCase)).ToList();
        var originIndex = (sameNamed.FirstOrDefault(p => p.Winning) ?? sameNamed.FirstOrDefault())?.Slot;
        var destinationIndex = copies.FirstOrDefault(
            p => p.Name.Equals(destinationPlugin.Name, StringComparison.OrdinalIgnoreCase)
                && p.Origin.Equals(destinationPlugin.Origin, StringComparison.Ordinal))?.Slot;
        if (originIndex is not { } origin || destinationIndex is not { } destination || destination >= origin)
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

    // The one place a plain Copy as Override deserializes at all; every other type's own-fields copy
    // is the verbatim bytes.
    private string StripEmbeddedChildrenForShallowCopy(string body, string recordType, GameRelease release)
    {
        var record = _codec.Deserialize(body, release, recordType);
        ContainerChildFields.ClearAllChildSlots(record);
        return _codec.SerializeToText(record, release);
    }
}
