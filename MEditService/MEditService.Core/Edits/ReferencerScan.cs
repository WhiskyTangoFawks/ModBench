using System.Text.Json;
using MEditService.Core.PluginAdapter;
using MEditService.Core.Plugins;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Edits;

/// <summary>Which records link a FormKey, asked of the load order rather than the Index (ADR-0046
/// invariant 7): a tracked copy answers from its working tree through the collector, an untracked
/// one from its binary's own links.</summary>
internal sealed class ReferencerScan(
    LoadOrder loadOrder, IPluginAdapter importer, RecordTextCodec codec, SchemaReflector schemaReflector,
    ILogger logger)
{
    /// <summary>One tracked document that links the target: the record at its root, its schema table,
    /// and the embedded children inside it holding a link of their own. A null
    /// <c>SchemaType</c> is a document nothing could read.</summary>
    internal sealed record Referencing(
        PluginKey Plugin, SourceRepository Repository, SourceDocument Document, string? SchemaType,
        IReadOnlyList<string> EmbeddedFormKeys);

    /// <summary>Every copy linking <paramref name="targetFormKey"/>, the target record itself excluded:
    /// one typed remap moves its whole graph. <c>Untracked</c> names the copies whose links no
    /// renumber can rewrite.</summary>
    internal (List<Referencing> Tracked, List<string> Untracked) Of(string targetFormKey, PluginKey targetPlugin)
    {
        var tracked = new List<Referencing>();
        var untracked = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
        if (!FormKey.TryFactory(targetFormKey, out var target)) return (tracked, [.. untracked]);

        var release = loadOrder.GameRelease;
        var schemas = schemaReflector.GetSchemas(release);

        foreach (var copy in loadOrder.Participating)
        {
            var plugin = copy.Key;
            FormKey? itself = plugin == targetPlugin ? target : null;

            if (ModFolders.TrackedOf(loadOrder, plugin) is { } modFolder
                && SourceRepository.Open(modFolder, release) is { } repository)
            {
                tracked.AddRange(InTree(repository, plugin, target, itself, schemas, release));
            }
            else if (LinksTheTarget(copy, target, itself, release))
            {
                untracked.Add(plugin.Name);
            }
        }

        return (tracked, [.. untracked]);
    }

    private IEnumerable<Referencing> InTree(
        SourceRepository repository, PluginKey plugin, FormKey target, FormKey? itself,
        IReadOnlyDictionary<string, RecordTableSchema> schemas, GameRelease release)
    {
        var spelled = target.ToString();
        foreach (var document in repository.ReadAll(plugin))
        {
            // A link is the target's FormKey spelled out, and case is the only spelling the codec's
            // own text differs in, so only a candidate reaches the collector.
            if (!document.Body.Contains(spelled, StringComparison.OrdinalIgnoreCase)) continue;

            // The header names plugins rather than records, and has no schema to walk it with.
            if (document.RecordType == PluginHeader.RecordType) continue;

            if (Decide(repository, plugin, document, target, itself, schemas, release) is { } referencing)
                yield return referencing;
        }
    }

    // Null is "this document links nothing". Every reader here is over text something else may have
    // written, so one that throws yields a document no schema names, which the caller refuses on.
    private Referencing? Decide(
        SourceRepository repository, PluginKey plugin, SourceDocument document, FormKey target, FormKey? itself,
        IReadOnlyDictionary<string, RecordTableSchema> schemas, GameRelease release)
    {
        try
        {
            // A path-ambiguous group's document names its own class rather than the schema's table,
            // so the record itself says which table it is in.
            var root = SchemaTypeOf(document, schemas, release, out var schemaType);

            // A type no schema names is one the collector cannot be run over, so the document travels
            // on for the remap-completeness guard to refuse rather than being passed over.
            var atRoot = !Is(document.FormKey, itself)
                         && (!schemas.TryGetValue(schemaType, out var schema)
                             || Links(document.Body, schema, target));

            var embedded = EmbeddedLinkers(document, root, target, itself, schemas, release);
            return atRoot || embedded.Count > 0
                ? new Referencing(plugin, repository, document, schemaType, embedded)
                : null;
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            logger.LogWarning(
                ex, "{Plugin} holds a document naming {FormKey} that could not be read while looking for referencers",
                plugin.Name, target);

            // A null schema type is a document nothing read, which the caller refuses on.
            return new Referencing(plugin, repository, document, SchemaType: null, []);
        }
    }


    // Non-null is the record the answer came from, so a container's walk below reads it rather than
    // parsing the same text twice.
    private IMajorRecord? SchemaTypeOf(
        SourceDocument document, IReadOnlyDictionary<string, RecordTableSchema> schemas, GameRelease release,
        out string schemaType)
    {
        if (schemas.ContainsKey(document.RecordType))
        {
            schemaType = document.RecordType;
            return null;
        }

        var root = codec.Deserialize(document.Body, release, document.RecordType);
        schemaType = SourceRecordType.Resolve(root, schemas);
        return root;
    }

    // A container's children serialize inline, and the owner's own schema walk never reaches them.
    // Each is asked of its own schema, as ingest asks it.
    private List<string> EmbeddedLinkers(
        SourceDocument document, IMajorRecord? parsed, FormKey target, FormKey? itself,
        IReadOnlyDictionary<string, RecordTableSchema> schemas, GameRelease release)
    {
        var linkers = new List<string>();
        if (!ContainerChildFields.HasChildFields(document.RecordType, release)) return linkers;

        var root = parsed ?? codec.Deserialize(document.Body, release, document.RecordType);
        foreach (var child in EmbeddedDescendants(root))
        {
            if (Is(child.FormKey, itself)) continue;
            if (!schemas.TryGetValue(SourceRecordType.Resolve(child, schemas), out var childSchema)) continue;

            var body = codec.SerializeToText(child, release);
            if (Links(body, childSchema, target)) linkers.Add(child.FormKey.ToString());
        }
        return linkers;
    }

    // Every child the document itself carries, at any depth: a worldspace inlines its top cell, which
    // inlines its placed references.
    private static IEnumerable<IMajorRecordGetter> EmbeddedDescendants(IMajorRecordGetter record)
    {
        var parentType = ContainerChildFields.NormalizedTypeName(record.GetType());
        foreach (var (slotName, _, child) in ContainerChildFields.EnumerateChildren(record))
        {
            if (!ContainerChildFields.EmbeddedSlots.Contains((parentType, slotName))) continue;
            yield return child;
            foreach (var deeper in EmbeddedDescendants(child)) yield return deeper;
        }
    }

    // By parsed FormKey, never by text: a document something else edited may spell the same key in a
    // different case, and a string comparison reads that as a different record.
    private static bool Links(string body, RecordTableSchema schema, FormKey target)
    {
        using var document = JsonDocument.Parse(body);
        return FormReferences.Collect(document.RootElement, schema)
            .Any(reference => Is(reference.TargetFormKey, target));
    }

    private static bool Is(string spelled, FormKey? other) =>
        other is { } key && FormKey.TryFactory(spelled, out var parsed) && parsed == key;

    private static bool Is(FormKey formKey, FormKey? other) => other is { } key && formKey == key;

    // An untracked copy is refused rather than rewritten, so only the yes-or-no matters: Mutagen's own
    // walk answers it without serializing a record.
    private bool LinksTheTarget(RegisteredCopy copy, FormKey target, FormKey? itself, GameRelease release)
    {
        ILoadedMod opened;
        try
        {
            opened = importer.Open(copy, release);
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            // MO2 replaces and removes a copy's file whenever it likes. An unreadable copy is one no
            // cascade can rewrite anyway, and its dangling link is compile's to report.
            logger.LogWarning(
                ex, "Skipping {Plugin} ({Origin}) while looking for referencers of {FormKey}: it could not be read",
                copy.Name, copy.Origin, target);
            return false;
        }

        using var _ = opened;

        // A FormID indexes this copy's own master list, so a copy that does not master the target's
        // plugin cannot express a link to it — the header answers before the walk starts.
        if (!Masters(opened.Getter, copy).Contains(target.ModKey.FileName.String)) return false;

        foreach (var record in opened.Getter.EnumerateMajorRecords())
        {
            if (Is(record.FormKey, itself)) continue;
            if (record.EnumerateFormLinks().Any(link => link.FormKey == target)) return true;
        }
        return false;
    }

    // The copy itself counts: a plugin's own records are addressable without a master entry.
    private static HashSet<string> Masters(IModGetter mod, RegisteredCopy copy) =>
        new(mod.MasterReferences.Select(r => r.Master.FileName.String).Append(copy.Name),
            StringComparer.OrdinalIgnoreCase);
}
