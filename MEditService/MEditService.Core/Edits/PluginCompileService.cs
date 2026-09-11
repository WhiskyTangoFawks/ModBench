using System.Text.Json;
using MEditService.Core.PluginAdapter;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Core.Edits;

/// <summary>ADR-0007's Save &amp; Compile: source (working tree or a named git ref) to binary. Reads
/// the source's own bytes, never the DB index; refuses only what it structurally cannot emit, and
/// the rest becomes diagnostics.</summary>
public sealed class PluginCompileService(
    LoadOrderHolder loadOrderHolder,
    SchemaReflector schemaReflector,
    RecordTextCodec codec,
    IPluginAdapter adapter,
    PluginWriter writer,
    ILogger<PluginCompileService> logger)
{
    public CompileResult Compile(PluginKey plugin, CompileSource source)
    {
        var loadOrder = loadOrderHolder.Current;
        if (loadOrder.Copies.Count == 0)
            return CompileResult.Refused("No load order has been received.");
        if (loadOrder.Copy(plugin) is not { } copy)
            return CompileResult.Refused($"{plugin.Name} is not in the load order.");
        if (ModFolders.TrackedOf(loadOrder, plugin) is not { } modFolder)
            return CompileResult.Refused($"{plugin.Name} is not tracked, so there is no source to compile.");

        // One repository for the whole pass, so the tree it answers from is read once: everything below
        // asks it for the same source, the working tree or a named ref.
        var atRef = source is CompileSource.AtRef atRefSource ? atRefSource.Ref : null;
        var repository = SourceRepository.Over(modFolder, loadOrder.GameRelease);
        var files = repository.FilesOf(plugin, atRef);
        if (files.Count == 0)
        {
            return CompileResult.Refused(
                $"{plugin.Name} has no source tree at {atRef ?? "the working tree"}, so there is nothing to compile.");
        }

        var (parsedTree, deserializeRefusal) = DeserializeSource(files, plugin.Name, loadOrder.GameRelease);
        if (deserializeRefusal != null)
            return CompileResult.Refused(deserializeRefusal);
        var tree = parsedTree!;

        // An ESL-addressable plugin with native records outside the light FormID range would compile
        // to a binary the game mis-addresses, so refuse it. Only a header flag can be removed; a
        // plugin light by .esl extension needs renaming.
        if (tree.IsLight(plugin.Name) && tree.SmallMasterRange is { } lightRange)
        {
            var outOfRange = tree.FormKeys
                .Where(key => key.ModKey == tree.ModKey
                    && (key.ID < lightRange.Min || key.ID > lightRange.Max))
                .Select(key => key.ToString())
                .ToList();
            if (outOfRange.Count > 0)
            {
                var flagRemovable = tree.IsSmallMaster;
                var remedy = flagRemovable
                    ? "Remove the ESL flag (the header's IsSmallMaster member), or renumber the record(s) into the light range."
                    : "Rename the plugin off the .esl extension, or renumber the record(s) into the light range.";
                return CompileResult.Refused(
                    $"{plugin.Name} is ESL-addressable but holds native FormID(s) outside the light range " +
                    $"(0x{lightRange.Min:X}-0x{lightRange.Max:X}): {string.Join(", ", outOfRange.Take(4))}" +
                    (outOfRange.Count > 4 ? $" and {outOfRange.Count - 4} more" : "") +
                    $". {remedy}",
                    eslContradiction: flagRemovable);
            }
        }

        // Two source units claiming one FormKey can only become one binary record, so refuse rather
        // than pick a winner. Asked of the files: the reader's group cache has already resolved a
        // same-folder collision before the tree is read.
        var collidingFormKeys = repository.CollidingFormKeys(plugin, tree.FormKeys, atRef);
        if (collidingFormKeys.Count > 0)
        {
            return CompileResult.Refused(
                $"{plugin.Name} cannot be compiled: more than one source file claims the same FormKey — " +
                $"{string.Join(", ", collidingFormKeys)}.");
        }

        var roundTripRefusal = RefuseIfSourceDoesNotRoundTrip(tree, plugin.Name, files);
        if (roundTripRefusal != null)
            return CompileResult.Refused(roundTripRefusal);

        var (diagnostics, masters) = ContentFacts(tree, plugin, loadOrder, repository, atRef);

        var loadOrderNames = loadOrder.Copies
            .Where(c => c.Registration.InLoadOrder)
            .OrderBy(c => c.Slot!.Value)
            .Select(c => c.Name)
            .ToList();

        // A crash mid-flight is what the journal marker is for: only the unmappable-FormID shape is
        // caught, so any other throw leaves it crash-shaped. PluginWriter never touches the plugin
        // until Commit(), so refusing is safe.
        string? writeRefusal = null;
        CompileJournal.RunBatch(modFolder, [plugin.Name], _ =>
        {
            try
            {
                tree.SaveThroughAsync(writer, copy.Path, loadOrderNames).GetAwaiter().GetResult();
            }
            catch (Exception ex) when (PluginDiagnosis.HasUnmappableFormID(ex))
            {
                // A struct-list script property's FormLink is invisible to Mutagen's EnumerateFormLinks
                // (Mutagen issue 688), so the content-derived master pass (ADR-0008) prunes a
                // master this write still needs. Every other write failure propagates raw.
                writeRefusal = $"{plugin.Name} could not be compiled: {PluginDiagnosis.FromWriteException(ex).Describe()}";
                return false;
            }

            // The parked snapshot advances only after the binary write has landed. An AtRef compile
            // parks too: otherwise the parked trailer still names the old working-tree hash and
            // Modbench's own write reads as an external change.
            SourceRepository.ParkCompileSnapshot(
                modFolder, plugin.Name, atRef, PluginBinaryHash.TrailerFormOfFile(copy.Path));
            return true;
        });
        if (writeRefusal != null)
            return CompileResult.Refused(writeRefusal);

        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation("Compiled {Plugin} ({Origin}) from {RecordCount} source records",
                plugin.Name, plugin.Origin, tree.FormKeys.Count);
        }
        return CompileResult.Success(diagnostics, masters);
    }

    // ADR-0015 invariant 1: the write side never reads the Index, so the masters content requires
    // (ADR-0008) and the check errors the editor shows come from the records here, through the
    // same collector, schema and link resolver.
    private (List<CompileDiagnostic> Diagnostics, IReadOnlyList<string> Masters) ContentFacts(
        CompiledTree tree, PluginKey plugin, LoadOrder loadOrder, SourceRepository repository, string? atRef)
    {
        // One walk, and the record type is the one RecordTableName gives, so what compile files a
        // record under and what the tree calls it cannot differ. A type no schema claims has no
        // document, so nothing is derived from it.
        var schemas = schemaReflector.GetSchemas(loadOrder.GameRelease);
        var typed = new List<(string RecordType, RecordTableSchema Schema, PluginDocument Document, string? EditorId)>();
        foreach (var document in tree.Documents(schemas))
        {
            typed.Add((
                document.RecordType, schemas[document.RecordType], document,
                WriteTargets.EditorIdOf(document.Text)));
        }

        var own = new Dictionary<string, RecordLookupEntry>(StringComparer.OrdinalIgnoreCase);
        foreach (var (recordType, _, document, editorId) in typed)
            own[document.FormKey] = new RecordLookupEntry(recordType, editorId);

        // The records just read answer for this plugin, at the ref being compiled; the working tree
        // the resolver reads for a tracked plugin is a different answer at a named ref.
        using var links = new FormLinkResolver(loadOrder, adapter, schemaReflector);
        RecordLookupEntry? ResolveOnce(string formKey)
        {
            if (own.TryGetValue(formKey, out var entry)) return entry;
            return IsNative(formKey, plugin) ? null : links.Resolve(formKey);
        }

        // One answer per distinct FormKey: the resolver walks a tracked target's whole tree per call,
        // and the same link recurs across a plugin's records.
        var resolve = FormKeyResolutionCache.Memoize(ResolveOnce);

        // debt #779: the resolver cannot name an embedded child in a tracked plugin, so a link
        // that plugin's tree does carry is one this pass has no answer for, not a broken one.
        var trackedTrees = new Dictionary<string, SourceRepository?>(StringComparer.OrdinalIgnoreCase);
        bool AnswersFor(string formKey) =>
            resolve(formKey) is not null || !EmbeddedInATrackedPlugin(formKey, plugin, loadOrder, trackedTrees);

        var diagnostics = new List<CompileDiagnostic>();
        var masters = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var (recordType, schema, record, editorId) in typed)
        {
            var formKey = record.FormKey;
            // An override carries another plugin's FormKey, which needs that plugin as a master
            // whether or not the record references anything.
            if (PluginNameIn(formKey) is { } native) masters.Add(native);

            using var document = JsonDocument.Parse(record.Text);
            foreach (var reference in FormReferences.Collect(document.RootElement, schema))
            {
                if (PluginNameIn(reference.TargetFormKey) is { } target) masters.Add(target);
            }

            var errors = CheckErrors(schema, document.RootElement, resolve, loadOrder.GameRelease, AnswersFor);
            if (errors.Count == 0) continue;

            // Only records with something to report pay for resolution, which keeps a container's
            // subtree scan off the common path.
            var relativePath = repository
                .RelativePathOf(plugin, new RecordIdentity(formKey, recordType, editorId), atRef)
                ?? string.Empty;
            diagnostics.AddRange(errors.Select(message => new CompileDiagnostic(formKey, relativePath, message)));
        }

        masters.Remove(plugin.Name);
        return (diagnostics, InLoadOrderOrder(masters, loadOrder));
    }

    // The same fields the editor shows a CheckError on, from the same builder, so compile and the
    // record panel cannot hold two definitions of what is broken.
    private static List<string> CheckErrors(
        RecordTableSchema schema, JsonElement root, Func<string, RecordLookupEntry?> resolve,
        GameRelease release, Func<string, bool> answersFor)
    {
        var errors = new List<string>();
        foreach (var column in schema.RecordColumns)
        {
            var meta = column.ToFieldMetadata();
            // The collector's own gate: a column with no formKey leaf has nothing to check.
            if (!FormReferences.CarriesFormKeys(meta)) continue;

            var checkError = CheckErrorBuilder.Build(
                DocumentNodes.VariantFor(meta, root), DocumentNodes.At(root, column.PropertyName),
                resolve, release, answersFor: answersFor);
            if (checkError != null) errors.Add($"{meta.Name}: {checkError}");
        }
        return errors;
    }

    // A master the load order holds sorts by its slot; one it does not falls after every held
    // master, alphabetically among themselves, so the result is stable either way.
    private static IReadOnlyList<string> InLoadOrderOrder(HashSet<string> masters, LoadOrder loadOrder)
    {
        if (masters.Count == 0) return [];

        var slots = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        foreach (var copy in loadOrder.Copies)
        {
            if (copy.Slot is not { } slot) continue;
            if (!slots.TryGetValue(copy.Name, out var held) || slot < held) slots[copy.Name] = slot;
        }

        return [.. masters
            .OrderBy(m => slots.GetValueOrDefault(m, int.MaxValue))
            .ThenBy(m => m, StringComparer.OrdinalIgnoreCase)];
    }

    private static bool IsNative(string formKey, PluginKey plugin) =>
        PluginNameIn(formKey) is { } owner && owner.Equals(plugin.Name, StringComparison.OrdinalIgnoreCase);

    // One repository per tracked mod folder for the whole pass, so its owner map is built at most
    // once: every call here has already missed the resolver, which is the uncommon path.
    private static bool EmbeddedInATrackedPlugin(
        string formKey, PluginKey plugin, LoadOrder loadOrder, Dictionary<string, SourceRepository?> trackedTrees)
    {
        // The same chain the resolver walks, participation included (ADR-0013): a copy the game does
        // not load holds nothing this link points at, so its tree is not an answer either.
        if (IsNative(formKey, plugin)
            || PluginNameIn(formKey) is not { } owner
            || loadOrder.WinningCopy(owner) is not { } copy
            || !copy.Registration.Participates
            || ModFolders.TrackedOf(loadOrder, copy.Key) is not { } modFolder)
        {
            return false;
        }

        if (!trackedTrees.TryGetValue(modFolder, out var repository))
            trackedTrees[modFolder] = repository = SourceRepository.Open(modFolder, loadOrder.GameRelease);
        return repository?.CarriesEmbedded(copy.Key, formKey) == true;
    }

    // The plugin half of a FormKey, which is how a reference names the master it needs. Mutagen's
    // own parser, not a split on the colon: a FormKey's spelling is its definition.
    private static string? PluginNameIn(string formKey) =>
        FormKey.TryFactory(formKey, out var parsed) ? parsed.ModKey.FileName.String : null;

    // Whatever is wrong with the source, the remedy is re-Track (ADR-0006), so the catch is
    // deliberately unfiltered and the message uniform.
    private (CompiledTree? Tree, string? RefusalReason) DeserializeSource(
        IReadOnlyList<PristineFile> files, string pluginName, GameRelease release)
    {
        var read = PluginTrees.ReadTreeAsync(files, pluginName, codec, release).GetAwaiter().GetResult();
        if (read.Tree is { } tree) return (tree, null);

        logger.LogWarning(read.Error, "{Plugin} could not be read from its source", pluginName);
        return (null,
            $"{pluginName} could not be read from its source: {read.Diagnosis!.Describe()} " +
            "Re-Track to regenerate the source.");
    }

    // ADR-0006: the generated deserializer skips an unrecognized property or file without throwing,
    // so a successful parse proves nothing. The check is self-consistency in both directions: a
    // document the regeneration does not produce is content the parse dropped.

    // No live subrecord-inventory gate here, deliberately: that loss class arises only when Track
    // parses an external binary, never from Compile.
    private static string? RefuseIfSourceDoesNotRoundTrip(
        CompiledTree tree, string pluginName, IReadOnlyList<PristineFile> sourceFiles)
    {
        var regeneratedFiles = tree.SerializeToPristineFilesAsync(pluginName).GetAwaiter().GetResult();
        var headerDocument = SourceRepository.HeaderDocumentFor(pluginName);
        var read = sourceFiles.ToDictionary(file => file.RelativePath, file => file.Content, StringComparer.Ordinal);

        foreach (var file in regeneratedFiles)
        {
            if (read.TryGetValue(file.RelativePath, out var content)
                && content.AsSpan().SequenceEqual(file.Content))
            {
                continue;
            }

            var offender = file.RelativePath == headerDocument ? "the plugin header" : file.RelativePath;
            return $"{pluginName} does not round-trip through its own source: {offender} does not match " +
                "what the current codec would produce from it. Re-Track to regenerate the source.";
        }

        var regeneratedPaths = regeneratedFiles.Select(f => f.RelativePath).ToHashSet(StringComparer.Ordinal);
        var unproduced = read.Keys
            .Where(relativePath => !regeneratedPaths.Contains(relativePath))
            .Order(StringComparer.Ordinal)
            .FirstOrDefault();
        if (unproduced != null)
        {
            return $"{pluginName} does not round-trip through its own source: {unproduced} is in the source, " +
                "but the current codec produces no such file from it, so nothing it holds reaches the plugin " +
                "(a document left over from an earlier source layout, or a stray file). Re-Track to regenerate the source.";
        }

        return null;
    }
}
