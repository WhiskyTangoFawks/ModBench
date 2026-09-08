using System.Text;
using System.Text.Json;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
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
    LoadOrder loadOrder, IModImporter importer, RecordTextCodec codec, SchemaReflector schemaReflector,
    ILogger logger)
{
    /// <summary>One tracked document that links the target: the record at its root, and the embedded
    /// children inside it holding a link of their own. Both are rewritten by remapping that root,
    /// which is why they travel together.</summary>
    internal sealed record Referencing(
        PluginKey Plugin, SourceRepository Repository, SourceDocument Document, IReadOnlyList<string> EmbeddedFormKeys);

    /// <summary>Every copy linking <paramref name="targetFormKey"/>, the target record itself excluded:
    /// one typed remap moves its whole graph. <c>Untracked</c> names the copies whose links no
    /// renumber can rewrite.</summary>
    internal (List<Referencing> Tracked, List<string> Untracked) Of(string targetFormKey, PluginKey targetPlugin)
    {
        var release = loadOrder.GameRelease;
        var schemas = schemaReflector.GetSchemas(release);
        var tracked = new List<Referencing>();
        var untracked = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var copy in loadOrder.Participating)
        {
            var plugin = copy.Key;
            var itself = plugin == targetPlugin ? targetFormKey : null;

            if (ModFolders.TrackedOf(loadOrder, plugin) is { } modFolder
                && SourceRepository.Open(modFolder, release) is { } repository)
            {
                tracked.AddRange(InTree(repository, plugin, targetFormKey, itself, schemas, release));
            }
            else if (LinksTheTarget(copy, targetFormKey, itself, release))
            {
                untracked.Add(plugin.Name);
            }
        }

        return (tracked, [.. untracked]);
    }

    private IEnumerable<Referencing> InTree(
        SourceRepository repository, PluginKey plugin, string targetFormKey, string? itself,
        IReadOnlyDictionary<string, RecordTableSchema> schemas, GameRelease release)
    {
        foreach (var document in repository.ReadAll(plugin))
        {
            // A link is the target's FormKey spelled out, so a document whose text never says it holds
            // none: only a candidate reaches the collector.
            if (!document.Body.Contains(targetFormKey, StringComparison.OrdinalIgnoreCase)) continue;

            // The header names plugins rather than records, and has no schema to walk it with.
            if (document.RecordType == PluginHeader.RecordType) continue;

            var atRoot = !document.FormKey.Equals(itself, StringComparison.Ordinal)
                         && schemas.TryGetValue(document.RecordType, out var schema)
                         && Links(document.Body, schema, targetFormKey);

            var embedded = EmbeddedLinkers(document, targetFormKey, itself, schemas, release);
            if (atRoot || embedded.Count > 0)
                yield return new Referencing(plugin, repository, document, embedded);
        }
    }

    // A container's children serialize inline, and the owner's own schema walk never reaches them.
    // Each is asked of its own schema, as ingest asks it.
    private List<string> EmbeddedLinkers(
        SourceDocument document, string targetFormKey, string? itself,
        IReadOnlyDictionary<string, RecordTableSchema> schemas, GameRelease release)
    {
        var linkers = new List<string>();
        if (!RecordEditService.IsContainerType(document.RecordType, release)) return linkers;

        var root = codec
            .DeserializeFromBytesAsync(Encoding.UTF8.GetBytes(document.Body), release, document.RecordType)
            .GetAwaiter().GetResult();
        foreach (var child in EmbeddedDescendants(root))
        {
            var childFormKey = child.FormKey.ToString();
            if (childFormKey.Equals(itself, StringComparison.Ordinal)) continue;
            if (!schemas.TryGetValue(SourceRecordType.Resolve(child, schemas), out var childSchema)) continue;

            var body = Encoding.UTF8.GetString(codec.SerializeToBytesAsync(child, release).GetAwaiter().GetResult());
            if (Links(body, childSchema, targetFormKey)) linkers.Add(childFormKey);
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

    private static bool Links(string body, RecordTableSchema schema, string targetFormKey)
    {
        using var document = JsonDocument.Parse(body);
        return FormReferences.Collect(document.RootElement, schema)
            .Any(reference => reference.TargetFormKey.Equals(targetFormKey, StringComparison.Ordinal));
    }

    // An untracked copy is refused rather than rewritten, so only the yes-or-no matters: Mutagen's own
    // walk answers it without serializing a record.
    private bool LinksTheTarget(RegisteredCopy copy, string targetFormKey, string? itself, GameRelease release)
    {
        if (!FormKey.TryFactory(targetFormKey, out var target)) return false;

        ILoadedMod opened;
        try
        {
            opened = importer.Open(copy, release);
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            // MO2 replaces and removes a copy's file whenever it likes. A copy no longer readable is
            // one no cascade could have rewritten anyway; its dangling link is compile's to report.
            logger.LogWarning(
                ex, "Skipping {Plugin} ({Origin}) while looking for referencers of {FormKey}: it could not be read",
                copy.Name, copy.Origin, targetFormKey);
            return false;
        }

        using var _ = opened;

        // A FormID indexes this copy's own master list, so a copy that does not master the target's
        // plugin cannot express a link to it — the header answers before the walk starts.
        if (!Masters(opened.Getter, copy).Contains(target.ModKey.FileName.String)) return false;

        foreach (var record in opened.Getter.EnumerateMajorRecords())
        {
            if (record.FormKey.ToString().Equals(itself, StringComparison.Ordinal)) continue;
            if (record.EnumerateFormLinks().Any(link => link.FormKey == target)) return true;
        }
        return false;
    }

    // The copy itself counts: a plugin's own records are addressable without a master entry.
    private static HashSet<string> Masters(IModGetter mod, RegisteredCopy copy) =>
        new(mod.MasterReferences.Select(r => r.Master.FileName.String).Append(copy.Name),
            StringComparer.OrdinalIgnoreCase);
}
