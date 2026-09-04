using System.Text;
using MEditService.Core.Plugins;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Plugins.Utility;

namespace MEditService.Core.Edits;

/// <summary>The spatial mint cluster <see cref="RecordEditService.CopyRecordAsOverride"/> composes:
/// auto-creates the WRLD/CELL ancestors a copied record needs. Shares the service's mirror and
/// schemaReflector so its writes are indistinguishable from the one write path (ADR-0041).</summary>
internal sealed class RecordCopy(ILoadOrderMirror mirror, SchemaReflector schemaReflector, ILogger logger, RecordTextCodec codec)
{
    /// <summary>Appends a placed reference into the destination's override of its Cell, auto-creating a
    /// bare Partial Form Cell when none exists. Bare fields are xEdit parity; Partial Form is a
    /// deliberate mEdit divergence (see <see cref="CreateInteriorCellParent"/>).</summary>
    internal RecordEditResult CopyPlacedReferenceAsOverride(
        PluginKey sourcePlugin, string formKey, RecordDocument document, PlacementRow placement,
        PluginKey destinationPlugin, string destinationModFolder, IRecordIndex index, GameRelease release)
    {
        if (!RecordEditService.IsFreeAtBothRefs(index, destinationPlugin, formKey))
        {
            // The explicitly-selected ref already held at Effective is replaced in place, never
            // duplicated or refused. Held only at Head (deleted in the working tree) still refuses.
            if (index.At(RecordRef.Effective).GetDocument(formKey, destinationPlugin) != null)
            {
                return ReplacePlacedReferenceInPlace(
                    sourcePlugin, formKey, document, destinationPlugin, destinationModFolder, index, release);
            }
            return RecordEditResult.Refused(
                RecordEditRefusal.FormKeyCollision,
                $"{formKey} is already held by a record in {destinationPlugin.Name} at some ref.");
        }

        var reads = index.At(RecordRef.Effective);
        var cellFormKey = placement.ParentCell;
        var cellDocument = reads.GetDocument(cellFormKey, destinationPlugin);
        if (cellDocument == null)
        {
            // Only a genuine SubCells cell mints (it has a BlockX); a TopCell's cell_location row
            // carries none, so it falls to the refusal below.
            var sourceCellLocation = reads.GetCellLocation(sourcePlugin, cellFormKey);
            if (sourceCellLocation?.IsInterior == false && sourceCellLocation.Value.BlockX != null)
            {
                return MintExteriorCellAroundPlacedReference(
                    sourcePlugin, formKey, document, placement, cellFormKey, sourceCellLocation.Value,
                    destinationPlugin, destinationModFolder, index, release);
            }

            if (sourceCellLocation?.IsInterior != true)
            {
                return RecordEditResult.Refused(
                    RecordEditRefusal.ContainerParentMissingInDestination,
                    $"{destinationPlugin.Name} has no override of {cellFormKey}, the cell {formKey} belongs to, " +
                    "and it is an exterior cell — auto-creating one needs spatial placement (worldspace " +
                    "block/sub-block) this write path does not compute yet, tracked separately.");
            }

            cellDocument = CreateInteriorCellParent(sourcePlugin, cellFormKey, destinationPlugin, destinationModFolder, index, release);
        }

        var cellUnit = SourceUnitResolver.Resolve(
            reads, destinationPlugin, destinationModFolder, cellFormKey, cellDocument.RecordType, cellDocument.EditorId, release)
            ?? throw new InvalidOperationException(
                $"{cellFormKey} is indexed in {destinationPlugin.Name} but SourceUnitResolver cannot find its source unit.");

        var cellRecord = RecordEditService.ReadRecordFromSource(codec, logger, cellUnit.FullPath, cellDocument, release);
        var childRecord = codec
            .DeserializeFromBytesAsync(Encoding.UTF8.GetBytes(document.Body!), release, document.RecordType)
            .GetAwaiter().GetResult();
        var slotName = SlotNameFor(placement);
        ContainerChildFields.AddChildToSlot(cellRecord, slotName, childRecord);

        var newCellBody = RecordEditService.SerializeAndWrite(codec, cellRecord, cellUnit.FullPath, release);

        // Child row first, so nothing ever transiently points a placement/container_child row at a
        // FormKey with no records row of its own.
        try
        {
            index.CreateWorkingTreeRecord(destinationPlugin, formKey, document.RecordType, document.Body!);
            index.ApplyWorkingTreeChanges(destinationPlugin, [(cellFormKey, newCellBody)]);
        }
        catch (Exception ex)
        {
            // The Cell's file already carries the child's bytes, so a failure here must not surface
            // as a bare exception that says nothing about the file that landed.
            logger.LogError(
                ex, "Index update failed after writing {CellFormKey}'s new body to {SourcePath} for copied child {FormKey}",
                cellFormKey, cellUnit.FullPath, formKey);
            return RecordEditResult.Refused(
                RecordEditRefusal.ContainerCopyIndexUpdateFailedAfterWrite,
                $"{cellFormKey}'s working-tree file was updated to carry {formKey}, but the index failed to " +
                $"record it ({ex.Message}). The file itself is a real, reviewable working-tree change — check " +
                "the Source Control panel, or relaunch mEdit to re-index it.");
        }
        mirror.ReapplyFilter();

        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "Copied {FormKey} from {SourcePlugin} ({SourceOrigin}) as an override into {DestinationPlugin} " +
                "({DestinationOrigin}) — appended into {CellFormKey}'s {SlotName} slot",
                formKey, sourcePlugin.Name, sourcePlugin.Origin, destinationPlugin.Name, destinationPlugin.Origin,
                cellFormKey, slotName);
        }
        return RecordEditResult.Success();
    }

    // ReplaceInSlot keeps the ref at its exact slot position; append-after-remove would silently
    // reorder the GRUP. The destination's cell is the right one even when the source has since moved
    // the ref elsewhere.
    private RecordEditResult ReplacePlacedReferenceInPlace(
        PluginKey sourcePlugin, string formKey, RecordDocument document,
        PluginKey destinationPlugin, string destinationModFolder, IRecordIndex index, GameRelease release)
    {
        var reads = index.At(RecordRef.Effective);
        var destinationPlacement = reads.GetPlacement(formKey, destinationPlugin)
            ?? throw new InvalidOperationException(
                $"{destinationPlugin.Name} holds {formKey} but its index has no placement row for it.");
        var cellFormKey = destinationPlacement.ParentCell;
        var cellDocument = reads.GetDocument(cellFormKey, destinationPlugin)
            ?? throw new InvalidOperationException(
                $"{destinationPlugin.Name}'s placement row parents {formKey} in {cellFormKey}, which it does not hold.");
        var cellUnit = SourceUnitResolver.Resolve(
                reads, destinationPlugin, destinationModFolder, cellFormKey, cellDocument.RecordType,
                cellDocument.EditorId, release)
            ?? throw new InvalidOperationException(
                $"{cellFormKey} is indexed in {destinationPlugin.Name} but SourceUnitResolver cannot find its source unit.");

        var cellRecord = RecordEditService.ReadRecordFromSource(codec, logger, cellUnit.FullPath, cellDocument, release);
        var found = ContainerChildFields.FindEmbeddedChild(cellRecord, formKey)
            ?? throw new InvalidOperationException(
                $"{cellUnit.RelativePath} is indexed as holding {formKey}, but its own text does not carry it.");
        var replacement = codec
            .DeserializeFromBytesAsync(Encoding.UTF8.GetBytes(document.Body!), release, document.RecordType)
            .GetAwaiter().GetResult();
        ContainerChildFields.ReplaceInSlot(cellRecord, found.SlotName, found.SlotIndex, replacement);

        var newCellBody = RecordEditService.SerializeAndWrite(codec, cellRecord, cellUnit.FullPath, release);
        var newChildBody = Encoding.UTF8.GetString(
            codec.SerializeToBytesAsync(replacement, release).GetAwaiter().GetResult());
        index.ApplyWorkingTreeChanges(destinationPlugin, [(cellFormKey, newCellBody), (formKey, newChildBody)]);
        mirror.ReapplyFilter();

        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "Copied {FormKey} from {SourcePlugin} ({SourceOrigin}) as an override into {DestinationPlugin} " +
                "({DestinationOrigin}) — replaced the existing embedded copy in {CellFormKey} at its own slot",
                formKey, sourcePlugin.Name, sourcePlugin.Origin, destinationPlugin.Name, destinationPlugin.Origin, cellFormKey);
        }
        return RecordEditResult.Success();
    }

    /// <summary>Mints an exterior CELL at its worldspace block/sub-block, auto-creating a bare Partial
    /// Form WRLD when the destination has none. Index rows are written from the exact bytes the mint
    /// wrote, never a second serialization.</summary>
    internal RecordEditResult MintExteriorCell(
        PluginKey sourcePlugin, string cellFormKey, CellLocationRow cellLocation, IMajorRecord cellRecord,
        PluginKey destinationPlugin, string destinationModFolder, IRecordIndex index, GameRelease release)
    {
        if (!RecordEditService.IsFreeAtBothRefs(index, destinationPlugin, cellFormKey))
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.FormKeyCollision,
                $"{cellFormKey} is already held by a record in {destinationPlugin.Name} at some ref.");
        }

        if (cellLocation.ParentWorldspace is not { } worldspaceFormKey)
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.ContainerParentMissingInDestination,
                $"{cellFormKey} has no recorded parent worldspace — cannot place it.");
        }

        // An existing worldspace override is merged into, resolved by scanning the tree: its directory
        // name carries the destination's EditorID, which the bare synthetic ancestor's never would.
        var reads = index.At(RecordRef.Effective);
        var existingWorldspace = reads.GetDocument(worldspaceFormKey, destinationPlugin);
        string? existingWorldspaceDirectory = null;
        if (existingWorldspace != null)
        {
            var worldspaceUnit = SourceUnitResolver.Resolve(
                reads, destinationPlugin, destinationModFolder, worldspaceFormKey,
                existingWorldspace.RecordType, existingWorldspace.EditorId, release)
                ?? throw new InvalidOperationException(
                    $"{worldspaceFormKey} is indexed in {destinationPlugin.Name} but SourceUnitResolver cannot find its source unit.");
            existingWorldspaceDirectory = Path.GetDirectoryName(worldspaceUnit.FullPath)!;
        }

        var sourceWorldspaceDocument = reads.GetDocument(worldspaceFormKey, sourcePlugin)
            ?? throw new InvalidOperationException(
                $"{sourcePlugin.Name} does not hold {worldspaceFormKey} — cell_location resolved this FormKey from its own row.");

        var worldspaceAncestor = BarePartialFormAncestor(worldspaceFormKey, "wrld", release);

        var syntheticMod = SpatialContainerMint.BuildSyntheticWorldspaceMod(
            destinationPlugin, worldspaceAncestor, cellLocation, cellRecord, release);
        var minted = SpatialContainerMint.MintAsync(
                syntheticMod, destinationModFolder, destinationPlugin.Name, existingWorldspaceDirectory)
            .GetAwaiter().GetResult();

        if (existingWorldspace == null)
        {
            index.CreateWorkingTreeRecord(
                destinationPlugin, worldspaceFormKey, sourceWorldspaceDocument.RecordType,
                Encoding.UTF8.GetString(minted.WorldspaceBody));
        }
        index.CreateCellLocation(destinationPlugin, cellLocation);
        index.CreateWorkingTreeRecord(destinationPlugin, cellFormKey, "cell", Encoding.UTF8.GetString(minted.CellBody));

        // Both callers rely on this leaving the index consistent, so the filter is reapplied here.
        mirror.ReapplyFilter();

        return RecordEditResult.Success();
    }

    // The REFR's Cell is auto-created bare and Partial Form with the REFR already in its slot, then
    // minted with its worldspace. The REFR's own row is written afterwards.
    private RecordEditResult MintExteriorCellAroundPlacedReference(
        PluginKey sourcePlugin, string formKey, RecordDocument document, PlacementRow placement, string cellFormKey,
        CellLocationRow cellLocation, PluginKey destinationPlugin, string destinationModFolder, IRecordIndex index,
        GameRelease release)
    {
        var bareCellRecord = BarePartialFormAncestor(cellFormKey, "cell", release);
        var childRecord = codec
            .DeserializeFromBytesAsync(Encoding.UTF8.GetBytes(document.Body!), release, document.RecordType)
            .GetAwaiter().GetResult();
        ContainerChildFields.AddChildToSlot(bareCellRecord, SlotNameFor(placement), childRecord);

        var mintResult = MintExteriorCell(
            sourcePlugin, cellFormKey, cellLocation, bareCellRecord, destinationPlugin, destinationModFolder, index, release);
        if (!mintResult.Applied) return mintResult;

        index.CreateWorkingTreeRecord(destinationPlugin, formKey, document.RecordType, document.Body!);
        mirror.ReapplyFilter();

        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "Copied {FormKey} from {SourcePlugin} ({SourceOrigin}) as an override into " +
                "{DestinationPlugin} ({DestinationOrigin}) — minted exterior cell {CellFormKey} " +
                "and its worldspace as Partial Form ancestors",
                formKey, sourcePlugin.Name, sourcePlugin.Origin, destinationPlugin.Name,
                destinationPlugin.Origin, cellFormKey);
        }
        return RecordEditResult.Success();
    }

    private static string SlotNameFor(PlacementRow placement) =>
        placement.PlacementGroup.Equals("persistent", StringComparison.Ordinal) ? "Persistent" : "Temporary";

    private IMajorRecord BarePartialFormAncestor(string formKey, string schemaKey, GameRelease release)
    {
        var schema = schemaReflector.GetSchemas(release)[schemaKey];
        var record = MajorRecordInstantiator.Activator(FormKey.Factory(formKey), release, schema.RecordType);
        PartialFormFlag.Set(record, true);
        return record;
    }

    // Bare fields, no EditorID is xEdit parity (AddIfMissingInternal's Assign() runs only under
    // `if aDeepCopy`, hardcoded False for ancestors). Partial Form is a deliberate divergence: xEdit
    // leaves the ancestor unflagged; mEdit flags it so conflict detection ignores its stub fields.
    private RecordDocument CreateInteriorCellParent(
        PluginKey sourcePlugin, string cellFormKey, PluginKey destinationPlugin, string destinationModFolder,
        IRecordIndex index, GameRelease release)
    {
        var reads = index.At(RecordRef.Effective);
        var sourceCellDocument = reads.GetDocument(cellFormKey, sourcePlugin)
            ?? throw new InvalidOperationException(
                $"{sourcePlugin.Name} does not hold {cellFormKey} — CopyPlacedReferenceAsOverride resolved this FormKey from its own placement row.");

        var record = BarePartialFormAncestor(cellFormKey, "cell", release);

        var placement = SourcePlacement.For(
            destinationPlugin.Name, "cell", cellFormKey, editorId: null, release,
            RecordEditService.EnsureInteriorCellBlockPath(destinationModFolder, destinationPlugin.Name, release));
        // Order is parent data (ADR-0042 decision 4): the placement already named the sub-block's entry.
        var bodyText = RecordEditService.WritePlaced(
            destinationModFolder, placement, cellFormKey.ToString(),
            path => RecordEditService.SerializeAndWrite(codec, record, path, release));

        index.CreateWorkingTreeRecord(destinationPlugin, cellFormKey, sourceCellDocument.RecordType, bodyText);
        mirror.ReapplyFilter();

        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "Auto-created {FormKey} as a Partial Form override in {DestinationPlugin} ({DestinationOrigin}) " +
                "— parent chain for a copied child",
                cellFormKey, destinationPlugin.Name, destinationPlugin.Origin);
        }

        return reads.GetDocument(cellFormKey, destinationPlugin)!;
    }
}
