using System.Text;
using System.Text.Json.Nodes;
using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Core.Commands;

/// <summary>The Edit gesture's handler (ADR-0046 invariant 3). Its four shared write concerns are
/// <see cref="WriteTargets"/>'s, so nothing here re-derives a target, a gate or a rename.</summary>
public sealed class EditRecordHandler
{
    private readonly WriteTargets _targets;
    private readonly LoadOrderHolder _loadOrder;
    private readonly Func<LoadOrder, FormLinkResolver> _resolvers;
    private readonly RecordTextCodec _codec;
    private readonly SchemaReflector _schemaReflector;
    private readonly ILogger<EditRecordHandler> _logger;

    // Internal because the shared module is, which is why this assembly registers its own handlers
    // (MEditService.Core.Composition) rather than the host naming a type it cannot see.
    internal EditRecordHandler(
        WriteTargets targets,
        LoadOrderHolder loadOrder,
        Func<LoadOrder, FormLinkResolver> resolvers,
        RecordTextCodec codec,
        SchemaReflector schemaReflector,
        ILogger<EditRecordHandler> logger)
    {
        (_targets, _loadOrder, _resolvers, _codec, _schemaReflector, _logger) =
            (targets, loadOrder, resolvers, codec, schemaReflector, logger);
    }

    /// <summary>The single write path (ADR-0041): one envelope, patched onto the record's document
    /// by <see cref="DocumentEdit"/>, landed here as a working-tree change. This method owns only
    /// the IO around that.</summary>
    public RecordEditResult Edit(PluginKey plugin, string formKey, RecordEditEnvelope envelope)
    {
        if (_targets.ResolveEditTarget(plugin, formKey, out var editTarget) is { } blocked) return blocked;
        var (release, identity, unit, repository) = editTarget;
        var spelled = RecordEditEnvelope.Spell(envelope.Path);

        var schemas = _schemaReflector.GetSchemas(release);
        if (!schemas.TryGetValue(identity.RecordType, out var schema))
        {
            return RecordEditResult.RefusedAt(
                RecordEditRefusal.FieldNotFound, spelled, $"'{identity.RecordType}' is not an editable record type.");
        }
        if (RefuseIfContainmentField(identity.RecordType, envelope.Path, schemas, release) is { } containmentRefusal)
            return containmentRefusal;

        // An embedded child is patched inside the document that carries it, so the identity written
        // back is that document's — its own for every other shape, the header included.
        var written = unit.IsEmbedded ? repository.IdentityOf(plugin, unit.OwnerFormKey, schemas) : identity;
        if (written is not { } target || repository.Get(plugin, target) is not { } document)
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.SourceUnitNotFound,
                $"{unit.RelativePath} does not hold {formKey} — it was moved or removed outside " +
                "Modbench. Check the Source Control panel.");
        }

        // The parent is what the file holds and what the codec reads, so every untouched byte of it
        // comes back intact.
        var text = document.Body;
        IReadOnlyList<PathHop> prefix = [];
        if (unit.IsEmbedded)
        {
            var parentType = RecordTypeDispatch.For(release).ConcreteFor(target.RecordType);
            var found = parentType == null
                ? null
                : EmbeddedChildPath.Find((JsonObject)JsonNode.Parse(text)!, ContainerChildFields.NormalizedTypeName(parentType), formKey);
            if (found == null)
            {
                return RecordEditResult.Refused(
                    RecordEditRefusal.SourceUnitNotFound,
                    // Deliberately does not blame an external change: a defect reads identically, and a
                    // wrong explanation sends the user hunting a problem that is not there.
                    $"{unit.RelativePath} was found holding {formKey}, but its own text does not " +
                    "carry it. If nothing outside Modbench changed that file, this is a defect — please " +
                    "report it; otherwise relaunch mEdit so the index re-reads the tree.");
            }
            prefix = found;
        }

        Func<string, string> roundTrip = schema.IsHeader
            ? patched => Encoding.UTF8.GetString(HeaderDocument.Write(HeaderDocument.Read(Encoding.UTF8.GetBytes(patched))))
            : patched => _codec.RoundTrip(patched, release, unit.OwnerRecordType);

        // One resolver per gesture over the load order as it stands now, so every link in this record
        // is answered from one reading of the tree and none outlives the write.
        using var resolver = _resolvers(_loadOrder.Current);
        var request = new DocumentEditRequest(text, prefix, schema, envelope, release, resolver.Resolve, roundTrip);

        string newText;
        RecordEditResult? refused;
        try
        {
            refused = DocumentEdit.Patch(request, out newText);
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

        // The document already said this (a value set to itself): nothing to commit, so no dirty file
        // or history entry.
        if (string.Equals(newText, text, StringComparison.Ordinal)) return RecordEditResult.Success();

        // The leaf name carries the EditorID, so an EditorID edit is a rename too. Done before the
        // write; newText is the written document's own text, so its root EditorID is the new name.
        var newEditorId = WriteTargets.EditorIdOf(newText);
        _targets.RenameTo(repository, plugin, target, newEditorId);
        repository.Put(plugin, new SourceDocument(target.FormKey, target.RecordType, newEditorId, newText));

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation(
                "Edited {Op} {Path} on {FormKey} in {Plugin} ({Origin}) — working-tree change written to {SourcePath}",
                envelope.Op, spelled, formKey, plugin.Name, plugin.Origin, unit.RelativePath);
        }
        return RecordEditResult.Success();
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
    // one would desynchronize the side tables, which nothing here re-derives. Refusing is why no
    // SetPlacement-style write-back exists; containment is the path (ADR-0041).
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
                "source tree's own structure rather than by a field (ADR-0041). Adding, removing or " +
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
