using System.Diagnostics.CodeAnalysis;
using System.Text;
using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Commands.Edits;

/// <summary>An edit's outcome and, when it applies, the changes it makes to plugin source. A failed write of
/// them refuses with <see cref="Failed"/>, the tree put back.</summary>
internal sealed record EditPlan(RecordEditResult Outcome, SourceChanges Changes, SourceRepository? Repository, string Failed)
{
    public static implicit operator EditPlan(RecordEditResult outcome) => new(outcome, SourceChanges.None, null, "");
}

/// <summary>A record edit as the changes it makes to plugin source, written nowhere (ADR-0007). The target
/// and the pre-write gate are <see cref="WriteTargets"/>'s, so nothing here re-derives one.</summary>
internal sealed class RecordEdit(WriteTargets targets, RecordTextCodec codec, SchemaReflector schemaReflector, ILogger logger)
{
    private readonly FormKeyChange _formKeyChange = new(codec, logger);
    private readonly CellLanding _cellLanding = new(targets, codec, schemaReflector, logger);

    /// <summary><paramref name="given"/> stands in for the file of the document carrying the record, which is
    /// read when it is null.</summary>
    internal EditPlan Plan(PluginAddress plugin, string formKey, RecordEditEnvelope envelope, string? given) =>
        WriteFailure.Refused<EditPlan>(
            () => EditSource(plugin, formKey, envelope, given), refused => refused, $"Could not write the source file for {formKey}", logger);

    private EditPlan EditSource(PluginAddress plugin, string formKey, RecordEditEnvelope envelope, string? given)
    {
        if (ItemWrite.RefuseWithoutGit() is { } gitMissing) return gitMissing;
        if (!TryCarrying(plugin, formKey, given, out var editTarget, out var document, out var blocked)) return blocked;
        var (release, identity, repository) = editTarget;
        var schemas = schemaReflector.GetSchemas(release);
        var relativePath = repository.RelativePathOf(plugin, identity);

        if (FormKeyChange.IsFormIdEdit(envelope)) return _formKeyChange.Change(plugin, formKey, editTarget, document, envelope.Value);
        var isEmbedded = !document.FormKey.Equals(identity.FormKey, StringComparison.Ordinal);
        var spelled = RecordEditEnvelope.Spell(envelope.Path);

        if (!schemas.TryGetValue(identity.RecordType, out var schema))
        {
            return RecordEditResult.RefusedAt(
                RecordEditRefusal.FieldNotFound, spelled, $"'{identity.RecordType}' is not an editable record type.");
        }
        if (RefuseIfContainmentField(identity.RecordType, envelope.Path, schemas, release) is { } containmentRefusal)
            return containmentRefusal;

        // The parent is what the file holds and what the codec reads, so every untouched byte of it
        // comes back intact.
        var target = document.Identity;
        var text = document.Body;
        IReadOnlyList<PathHop> prefix = [];
        string? cellToLookUp = null;
        if (isEmbedded)
        {
            var parentType = RecordTypeDispatch.For(release).ConcreteFor(target.RecordType);
            var root = JsonNode.Parse(text) as JsonObject
                ?? throw new InvalidOperationException($"Expected '{relativePath}' to hold a JSON object.");
            var found = parentType == null
                ? null
                : EmbeddedChildPath.Find(root, ContainerChildFields.NormalizedTypeName(parentType), formKey, release);
            if (found == null)
            {
                return RecordEditResult.Refused(
                    RecordEditRefusal.SourceUnitNotFound,
                    // Deliberately does not blame an external change: a defect reads identically, and a
                    // wrong explanation sends the user hunting a problem that is not there.
                    $"{relativePath} was found holding {formKey}, but its own text does not " +
                    "carry it. If nothing outside Modbench changed that file, this is a defect — please " +
                    "report it; otherwise relaunch mEdit so the index re-reads the tree.");
            }
            prefix = found;
            cellToLookUp = CellGroupMove.CellToLookUp(root, prefix, envelope);
        }

        cellToLookUp = RecordEmptying.CellToLookUp(text, prefix, envelope, schema, release) ?? cellToLookUp;
        var refills = RecordEmptying.RefillsFromTheLeft(text, prefix, envelope, schema);

        LeftCopy? cellCopyOnTheLeft = null;
        LeftCopy? refillCopyOnTheLeft = null;
        if (cellToLookUp is not null || refills)
        {
            if (WriteTargets.MastersOf(
                    repository, plugin, schemas, spelled, $"the copy of {formKey} read to its left", out var masters) is { } unreadable)
                return unreadable;
            if (cellToLookUp is not null)
                cellCopyOnTheLeft = targets.NearestCopyToTheLeft(plugin, cellToLookUp, PlacedCell.Says, among: masters);
            if (refills)
            {
                refillCopyOnTheLeft = targets.NearestCopyToTheLeft(
                    plugin, formKey, _ => true, RecordEmptying.EmptyingBits(schema), masters);
            }
        }

        Func<string, string> roundTrip = schema.IsHeader
            ? patched => Encoding.UTF8.GetString(HeaderDocument.Write(HeaderDocument.Read(Encoding.UTF8.GetBytes(patched))))
            : patched => codec.RoundTrip(patched, release, document.RecordType);

        var request = new DocumentEditRequest(
            text, prefix, schema, envelope, release, roundTrip, cellCopyOnTheLeft, refillCopyOnTheLeft);

        string newText;
        CellCrossing? crossing;
        RecordEditResult? refused;
        try
        {
            refused = DocumentEdit.Patch(request, out newText, out crossing);
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            // A document JsonDocument tolerates and JsonNode does not — duplicate members, most of
            // them — never reaches the codec, and this is the only reader that sees why.
            return WriteTargets.RefuseUnreadable(formKey, ex.Message, spelled);
        }
        // The codec rejected the patched document; whether the unpatched one reads decides whose fault
        // that is, and it is only asked once an edit has already failed.
        if (refused is { Refusal: RecordEditRefusal.CodecRejected } && Unreadable(roundTrip, text) is { } why)
            return WriteTargets.RefuseUnreadable(formKey, why, spelled);
        if (refused is { } rejected) return rejected;
        if (crossing is { } leaving) return _cellLanding.Land(plugin, editTarget, target, newText, leaving, spelled);

        // The document already said this (a value set to itself): nothing to commit, so no dirty file
        // or history entry.
        if (string.Equals(newText, text, StringComparison.Ordinal)) return RecordEditResult.Success();

        return new EditPlan(
            RecordEditResult.Success(),
            repository.ChangesToRewrite(plugin, new SourceDocument(target.FormKey, target.RecordType, WriteTargets.EditorIdOf(newText), newText)),
            repository, $"Could not write the source file for {formKey}.");
    }

    // An embedded child is patched inside the document that carries it, so the identity written back is
    // that document's: its own for every other shape, the header included.
    private bool TryCarrying(
        PluginAddress plugin, string formKey, string? given, out WriteTargets.EditTarget target,
        [NotNullWhen(true)] out SourceDocument? document, [NotNullWhen(false)] out RecordEditResult? refused)
    {
        if (given is not null) return targets.TryResolveEditTarget(plugin, formKey, given, out target, out document, out refused);

        document = null;
        refused = targets.ResolveEditTarget(plugin, formKey, out target);
        if (refused is not null) return false;

        var (release, identity, repository) = target;
        try
        {
            document = repository.ContainerDocument(plugin, identity, schemaReflector.GetSchemas(release));
        }
        catch (UnreadableSourceDocumentException ex)
        {
            refused = WriteTargets.RefuseUnreadable(formKey, ex.Message);
            return false;
        }
        if (document is not null) return true;

        refused = RecordEditResult.Refused(
            RecordEditRefusal.SourceUnitNotFound,
            $"{repository.RelativePathOf(plugin, identity) ?? $"{plugin.Name}'s source tree"} does not hold {formKey} — it was moved or removed outside " +
            "Modbench. Check the Source Control panel.");
        return false;
    }

    private static string? Unreadable(Func<string, string> roundTrip, string text)
    {
        try
        {
            roundTrip(text);
            return null;
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            return ex.Message;
        }
    }

    // Reflection makes child slots, Cell.Grid and placed Position ordinary writable columns; writing
    // one would desynchronize the side tables, which nothing here re-derives. No SetPlacement-style
    // write-back exists: containment is the path (ADR-0006).
    private static RecordEditResult? RefuseIfContainmentField(
        string recordType, IReadOnlyList<PathHop> path, IReadOnlyDictionary<string, RecordTableSchema> schemas, GameRelease release)
    {
        var fieldPath = path.Count > 0 ? path[0].Name : null;
        if (!schemas.TryGetValue(recordType, out var schema)) return null;
        if (schema.RecordColumns.FirstOrDefault(c => c.Name == fieldPath) is not { } column) return null;
        if (RecordTypeDispatch.For(release).ConcreteFor(recordType) is not { } concrete) return null;

        // The schema column's own property name, so this guard and the reflector cannot disagree.
        if (ContainerChildFields.EnumerateChildFieldsFor(concrete) is { } childSlots
            && childSlots.Contains(column.PropertyName, StringComparer.Ordinal))
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.FieldReadOnly,
                $"'{fieldPath}' holds {recordType}'s child records, and containment is expressed by the " +
                "source tree's own structure rather than by a field (ADR-0006). Adding, removing or " +
                "reordering a container's children is a structural gesture, not a field edit.");
        }

        if (column.PropertyName.Equals("Grid", StringComparison.Ordinal)
            && ContainerChildFields.NormalizedTypeName(concrete).Equals("Cell", StringComparison.Ordinal))
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.FieldReadOnly,
                "'grid' is an exterior cell's own place in the world — its source directory is named " +
                "after these coordinates, so moving it restructures the tree rather than rewriting one " +
                "file. That is a structural gesture, not a field edit.");
        }

        // Resolved through the game's own IPlacedGetter marker, not a hardcoded type list, so this
        // holds for whichever types a game module gives Position to.
        if (column.PropertyName.Equals("Position", StringComparison.Ordinal)
            && concrete.Assembly.GetType($"{concrete.Namespace}.IPlacedGetter") is { } placedGetterType
            && placedGetterType.IsAssignableFrom(concrete))
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.FieldReadOnly,
                "'position' is copied into the placement index (which cell a reference is in, and " +
                "where) — nothing on this path re-derives that side table, so a placed reference's " +
                "position is not writable through a field edit.");
        }

        return null;
    }
}
