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

/// <summary>
/// The exterior-cell/worldspace-override mint cluster (#607) — spatial logic
/// <see cref="RecordEditService.CopyRecordAsOverride"/> composes rather than restates inline: auto-creating
/// the missing WRLD/CELL ancestors a copied exterior Cell or placed reference needs in a destination
/// that overrides neither yet, and the sibling interior-Cell auto-create
/// (<see cref="CreateInteriorCellParent"/>) both share the same bare/Partial-Form ancestor recipe with
/// (<see cref="BarePartialFormAncestor"/>). <see cref="SpatialContainerMint"/> is the lower-level
/// mechanism this calls into (build the synthetic mod, serialize it through the whole-mod door, merge
/// into the destination tree) — this class is the orchestration one level up: refusals, index notify,
/// filter reapply, logging, exactly as <see cref="RecordEditService"/> itself does for every other
/// write path. Shares <see cref="RecordEditService"/>'s own <c>mirror</c>/<c>schemaReflector</c>/codec
/// instances (constructor-composed, never a second copy) so every write this makes is indistinguishable
/// from one <see cref="RecordEditService"/> made directly — ADR-0041's "exactly one write path" is
/// concentrated here, never forked.
/// </summary>
internal sealed class RecordCopy(ILoadOrderMirror mirror, SchemaReflector schemaReflector, ILogger logger, RecordTextCodec codec)
{
    /// <summary>
    /// Copy as Override for a placed reference — appends
    /// <paramref name="formKey"/> into the destination's existing override of its own Cell
    /// (<paramref name="placement"/>'s <see cref="PlacementRow.ParentCell"/>) when one already exists,
    /// touching nothing else about that Cell (not even its Partial Form flag). When the destination has
    /// no override of that Cell yet and the Cell is interior, one is auto-created first — bare fields,
    /// Partial Form flagged. Bare fields are genuine xEdit parity; Partial Form is a deliberate
    /// mEdit-specific divergence from what xEdit itself does — <see cref="CreateInteriorCellParent"/>'s
    /// own doc comment has the full trace and argument, not repeated here.
    /// </summary>
    internal RecordEditResult CopyPlacedReferenceAsOverride(
        PluginKey sourcePlugin, string formKey, RecordDocument document, PlacementRow placement,
        PluginKey destinationPlugin, string destinationModFolder, IRecordIndex index, GameRelease release)
    {
        if (!RecordEditService.IsFreeAtBothRefs(index, destinationPlugin, formKey))
        {
            // #550 AC7: the explicitly-selected ref already held at Effective is replaced in place,
            // at its existing slot position — never duplicated, never refused. Held only at Head
            // (deleted in the working tree) still refuses: nothing at Effective to replace.
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
            // IsInterior's own double-duty note lives on CopyRecordAsOverride's identical check —
            // only the genuine-SubCells case mints (a real BlockX to mint from); a
            // TopCell ref's own cell_location row carries none, so it falls to the refusal below.
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

        // Two rows change: the child's own (new — CreateWorkingTreeRecord, the same "exists at neither
        // ref yet" shape every other copy-as-override uses) and the Cell's own existing row (its body
        // moved — ApplyWorkingTreeChanges, the same shape EditField's own embedded-child write uses).
        // Child first, so nothing ever transiently points a placement/container_child row at a FormKey
        // with no records row of its own.
        try
        {
            index.CreateWorkingTreeRecord(destinationPlugin, formKey, document.RecordType, document.Body!);
            index.ApplyWorkingTreeChanges(destinationPlugin, [(cellFormKey, newCellBody)]);
        }
        catch (Exception ex)
        {
            // The Cell's file on disk already carries formKey's new bytes
            // (WriteBodyAtomic-equivalent SerializeAsync above already landed) — a should-never-happen
            // guard in one of these two calls must not surface as a bare, unhandled exception that says
            // nothing about that. RecordEditRefusal's own doc comment has the full argument.
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

    /// <summary>
    /// #550 AC7's placed-reference replace: the destination's own cell keeps the ref at its exact
    /// slot position (<see cref="ContainerChildFields.ReplaceInSlot"/> — append-after-remove would
    /// silently reorder the GRUP), with the source's bytes swapped in. The destination's cell is
    /// where <i>its</i> copy of the ref lives, which is the right one even when the source has since
    /// moved the ref to a different cell.
    /// </summary>
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

    /// <summary>
    /// Mints <paramref name="cellLocation"/>'s exterior CELL
    /// (<paramref name="cellRecord"/> — already the right shape, either the real requested copy with
    /// its embedded children stripped, or a bare auto-created ancestor holding just a copied REFR) at
    /// its exact worldspace block/sub-block, auto-creating a bare, Partial-Form WRLD ancestor first
    /// when the destination has none (the same idiom <see cref="CreateInteriorCellParent"/> already
    /// uses one level up — bare fields, no EditorID, <see cref="PartialFormFlag.Set"/> before
    /// serializing). Shared by <see cref="RecordEditService.CopyRecordAsOverride"/>'s own exterior-Cell
    /// branch and <see cref="CopyPlacedReferenceAsOverride"/>'s own exterior branch.
    ///
    /// <para>A destination that already overrides the worldspace (#597) keeps that override
    /// untouched — document, index row and Partial Form flag all exactly as they were — and the new
    /// block/sub-block/cell merge into its existing directory, resolved by scan
    /// (<see cref="SpatialContainerMint.MintAsync"/>'s own doc comment has the naming argument).</para>
    ///
    /// <para>Writes the worldspace's and cell's own index rows from the exact bytes
    /// <see cref="SpatialContainerMint.MintAsync"/> wrote to the working tree
    /// (<see cref="SpatialContainerMint.SpatialMintResult"/>), never a second, independently-serialized
    /// copy — the same "the source text is the source, not the index" rule <see cref="RecordEditService"/>
    /// states for every other write path.</para>
    /// </summary>
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

        // The destination may already override the worldspace (#597 — the common real-world case:
        // any plugin already touching this WRLD). Then the mint merges *into* that override's own
        // directory — resolved by scanning the tree (its name carries the destination's EditorID,
        // which the bare synthetic ancestor's never would) — and the WRLD's own document and index
        // row are left exactly as they are.
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

        // The two rows just minted (the auto-created WRLD ancestor, the CELL) can newly match an
        // active filter, the same as every other create/copy path here — this call has two distinct
        // callers (CopyRecordAsOverride's own direct exterior-Cell branch, and
        // MintExteriorCellAroundPlacedReference one level up) and must leave the index consistent on
        // its own regardless of which one is asking, rather than relying on a caller to remember it.
        mirror.ReapplyFilter();

        return RecordEditResult.Success();
    }

    /// <summary>
    /// <see cref="CopyPlacedReferenceAsOverride"/>'s exterior half — the copied REFR's own
    /// Cell does not exist in the destination and is a genuine SubCells cell, so the Cell is auto-created
    /// bare and Partial Form (exactly as <see cref="CreateInteriorCellParent"/> does one level up)
    /// with the REFR already in its source slot (<see cref="SlotNameFor"/>), and the pair is minted
    /// through <see cref="MintExteriorCell"/>. The REFR's own row is written afterwards — the cell's
    /// minted body already carries it inline either way.
    /// </summary>
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

    /// <summary>The Cell slot a <c>placement</c> row's own group name maps to — the two spellings
    /// <see cref="ContainerChildFields"/> knows a placed reference by.</summary>
    private static string SlotNameFor(PlacementRow placement) =>
        placement.PlacementGroup.Equals("persistent", StringComparison.Ordinal) ? "Persistent" : "Temporary";

    /// <summary>The auto-created ancestor: bare, default-constructed fields, no EditorID, Partial Form
    /// set before it is ever serialized — the one recipe <see cref="CreateInteriorCellParent"/>,
    /// <see cref="MintExteriorCell"/> and <see cref="MintExteriorCellAroundPlacedReference"/> share.
    /// <paramref name="schemaKey"/> is the schema table name (<c>"cell"</c>, <c>"wrld"</c>).</summary>
    private IMajorRecord BarePartialFormAncestor(string formKey, string schemaKey, GameRelease release)
    {
        var schema = schemaReflector.GetSchemas(release)[schemaKey];
        var record = MajorRecordInstantiator.Activator(FormKey.Factory(formKey), release, schema.RecordType);
        PartialFormFlag.Set(record, true);
        return record;
    }

    /// <summary>
    /// Silently creates <paramref name="cellFormKey"/> as an override in
    /// <paramref name="destinationPlugin"/> — the parent-chain auto-create the copy gestures
    /// need when a copied child's own Cell has no destination override yet. Bare, default-constructed
    /// fields, no EditorID (<see cref="MajorRecordInstantiator.Activator"/>, the same factory
    /// <see cref="RecordEditService.CreateRecord"/> uses, with no <c>record.EditorID = ...</c>
    /// follow-up) — xEdit's own <c>AddIfMissingInternal</c> genuinely does the same
    /// (<c>wbImplementation.pas</c>'s ancestor walk: its <c>Assign()</c> call, which is what would
    /// otherwise copy the master's fields and name, only runs inside an <c>if aDeepCopy then</c>
    /// branch that is hardcoded <c>False</c> for every auto-created ancestor), so this half is
    /// genuine ADR-0034 parity, not an approximation of it.
    ///
    /// <para><b>Partial Form is not xEdit parity, and is not claimed as such.</b> The same
    /// ancestor-walk trace that confirms the
    /// bare-fields parity above also shows real xEdit's own <c>IsPartialForm := True</c> line sits
    /// inside that same <c>if aDeepCopy then</c> branch — so xEdit itself leaves an auto-created
    /// ancestor Cell unflagged, not Partial Form. Setting it here is a deliberate mEdit-specific
    /// divergence, argued rather than assumed: Partial Form's whole purpose in this codebase
    /// is excluding a record's own fields from mEdit's git-native conflict-diff
    /// engine, which has no xEdit analog at all (root CLAUDE.md's own carve-out — tracking/compile/
    /// branch UX is scored against this product's own model, not xEdit's live in-memory comparison). A
    /// structurally-stub auto-created ancestor, whose fields were never meant to mean anything, is
    /// exactly the record that mechanism exists to exclude. <see cref="PartialFormFlag.Set"/> is the
    /// flag's own write surface, called directly here since there is no source file yet for
    /// <see cref="RecordEditService.EditField"/>'s own <c>is_partial_form</c> door to reach.</para>
    /// </summary>
    private RecordDocument CreateInteriorCellParent(
        PluginKey sourcePlugin, string cellFormKey, PluginKey destinationPlugin, string destinationModFolder,
        IRecordIndex index, GameRelease release)
    {
        var reads = index.At(RecordRef.Effective);
        var sourceCellDocument = reads.GetDocument(cellFormKey, sourcePlugin)
            ?? throw new InvalidOperationException(
                $"{sourcePlugin.Name} does not hold {cellFormKey} — CopyPlacedReferenceAsOverride resolved this FormKey from its own placement row.");

        var record = BarePartialFormAncestor(cellFormKey, "cell", release);

        var relativePath = RecordEditService.InteriorCellDestinationPath(
            destinationModFolder, destinationPlugin.Name, cellFormKey, editorId: null, release);
        var sourcePath = Path.Combine(destinationModFolder, relativePath);
        Directory.CreateDirectory(Path.GetDirectoryName(sourcePath)!);

        var bodyText = RecordEditService.SerializeAndWrite(codec, record, sourcePath, release);

        SourceUnitResolver.RenormalizeGroupOrder(Path.GetDirectoryName(sourcePath)!);

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
