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
using Mutagen.Bethesda.Plugins.Analysis;
using Mutagen.Bethesda.Plugins.Records;
using Noggog.WorkEngine;

namespace MEditService.Core.Edits;

/// <summary>ADR-0041's Save &amp; Compile: source (working tree or a named git ref) to binary. Reads
/// the source's own bytes, never the DB index; refuses only what it structurally cannot emit, and
/// the rest becomes diagnostics.</summary>
public sealed class PluginCompileService(
    LoadOrderHolder loadOrderHolder,
    SchemaReflector schemaReflector,
    RecordTextCodec codec,
    IPluginAdapter importer,
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

        // A compile at a named ref reads that ref's tree onto disk first, so both cases below are the
        // same "read this directory" call.
        using var checkout = SourceCheckout.Of(modFolder, plugin, source, loadOrder.GameRelease);
        if (!Directory.Exists(checkout.TreeRoot))
        {
            return CompileResult.Refused(
                $"{plugin.Name} has no source tree at {checkout.Description}, so there is nothing to compile.");
        }

        var (parsedMod, deserializeRefusal) = DeserializeSource(checkout.TreeRoot, plugin.Name);
        if (deserializeRefusal != null)
            return CompileResult.Refused(deserializeRefusal);
        var mod = parsedMod!;

        // An ESL-addressable plugin with native records outside the light FormID range would compile
        // to a binary the game mis-addresses, so refuse it. Only a header flag can be removed; a
        // plugin light by .esl extension needs renaming.
        if (PluginFlagPredicates.IsLight(mod, plugin.Name)
            && RecordCompactionCompatibilityDetection.GetSmallMasterRange(mod) is { } lightRange)
        {
            var outOfRange = mod.EnumerateMajorRecords()
                .Where(r => r.FormKey.ModKey == mod.ModKey
                    && (r.FormKey.ID < lightRange.Min || r.FormKey.ID > lightRange.Max))
                .Select(r => r.FormKey.ToString())
                .ToList();
            if (outOfRange.Count > 0)
            {
                var flagRemovable = mod.IsSmallMaster;
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
        // than pick a winner. Asked of the tree, not `mod`: the reader's group cache has already
        // resolved a same-folder collision before `mod` exists.
        var collidingFormKeys = SourceRepository
            .Over(checkout.ResolverRoot, loadOrder.GameRelease)
            .FormKeysWithMoreThanOneDocument(plugin, mod.EnumerateMajorRecords().Select(r => r.FormKey));
        if (collidingFormKeys.Count > 0)
        {
            return CompileResult.Refused(
                $"{plugin.Name} cannot be compiled: more than one source file claims the same FormKey — " +
                $"{string.Join(", ", collidingFormKeys)}.");
        }

        var roundTripRefusal = RefuseIfSourceDoesNotRoundTrip(mod, plugin.Name, checkout.ResolverRoot);
        if (roundTripRefusal != null)
            return CompileResult.Refused(roundTripRefusal);

        var (diagnostics, masters) = ContentFacts(mod, plugin, loadOrder, checkout.ResolverRoot);

        var loadOrderNames = loadOrder.Copies
            .Where(c => c.Registration.InLoadOrder)
            .OrderBy(c => c.Slot!.Value)
            .Select(c => c.Name)
            .ToList();

        // A crash mid-flight is what the journal marker is for: only the unmappable-FormID shape is
        // caught, so any other throw leaves it crash-shaped. PluginWriter never touches the plugin
        // until Commit(), so refusing is safe.
        var atRef = source is CompileSource.AtRef atRefSource ? atRefSource.Ref : null;
        string? writeRefusal = null;
        CompileJournal.RunBatch(modFolder, [plugin.Name], _ =>
        {
            try
            {
                writer.SaveFromModAsync(mod, copy.Path, loadOrderNames).GetAwaiter().GetResult();
            }
            catch (Exception ex) when (PluginDiagnosis.HasUnmappableFormID(ex))
            {
                // A struct-list script property's FormLink is invisible to Mutagen's EnumerateFormLinks
                // (Mutagen issue 688), so the content-derived master pass (ADR-0038) prunes a
                // master this write still needs. Every other write failure propagates raw.
                writeRefusal = $"{plugin.Name} could not be compiled: {PluginDiagnosis.FromWriteException(ex).Describe()}";
                return false;
            }

            // The parked snapshot advances only after the binary write has landed. An AtRef compile
            // parks too: otherwise the parked trailer still names the old working-tree hash and
            // Modbench's own write reads as an external change.
            var binarySha256 = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(copy.Path)));
            SourceRepository.ParkCompileSnapshot(modFolder, plugin.Name, atRef, binarySha256);
            return true;
        });
        if (writeRefusal != null)
            return CompileResult.Refused(writeRefusal);

        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation("Compiled {Plugin} ({Origin}) from {RecordCount} source records",
                plugin.Name, plugin.Origin, mod.EnumerateMajorRecords().Count());
        }
        return CompileResult.Success(diagnostics, masters);
    }

    // ADR-0046 invariant 1: the write side never reads the Index, so the masters content requires
    // (ADR-0038) and the check errors the editor shows come from the records here, through the
    // same collector, schema and link resolver.
    private (List<CompileDiagnostic> Diagnostics, IReadOnlyList<string> Masters) ContentFacts(
        IMod mod, PluginKey plugin, LoadOrder loadOrder, string resolverRoot)
    {
        // One walk, and the record type is the one SourceRecordType names, so what compile files a
        // record under and what the tree calls it cannot differ. A type no schema claims has no
        // document, so nothing is derived from it.
        var schemas = schemaReflector.GetSchemas(loadOrder.GameRelease);
        var typed = new List<(string RecordType, RecordTableSchema Schema, IMajorRecordGetter Record)>();
        foreach (var record in mod.EnumerateMajorRecords())
        {
            var recordType = RecordTableName.Of(record, schemas);
            if (schemas.TryGetValue(recordType, out var schema)) typed.Add((recordType, schema, record));
        }

        var own = new Dictionary<string, RecordLookupEntry>(StringComparer.OrdinalIgnoreCase);
        foreach (var (recordType, _, record) in typed)
            own[record.FormKey.ToString()] = new RecordLookupEntry(recordType, record.EditorID);

        // The records just read answer for this plugin, at the ref being compiled; the working tree
        // the resolver reads for a tracked plugin is a different answer at a named ref.
        using var links = new FormLinkResolver(loadOrder, importer, schemaReflector);
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

        // One repository for the pass, so its listing memo spans it: resolving per record against a
        // fresh tree scan dominated.
        var repository = SourceRepository.Over(resolverRoot, loadOrder.GameRelease);
        var diagnostics = new List<CompileDiagnostic>();
        var masters = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var (recordType, schema, record) in typed)
        {
            var formKey = record.FormKey.ToString();
            // An override carries another plugin's FormKey, which needs that plugin as a master
            // whether or not the record references anything.
            if (PluginNameIn(formKey) is { } native) masters.Add(native);

            // The document, not the live object: what a reference is, is what the source file holds.
            var body = codec.SerializeToBytesAsync(record, loadOrder.GameRelease).GetAwaiter().GetResult();
            using var document = JsonDocument.Parse(body);
            foreach (var reference in FormReferences.Collect(document.RootElement, schema))
            {
                if (PluginNameIn(reference.TargetFormKey) is { } target) masters.Add(target);
            }

            var errors = CheckErrors(schema, document.RootElement, resolve, loadOrder.GameRelease, AnswersFor);
            if (errors.Count == 0) continue;

            // Only records with something to report pay for resolution, which keeps a container's
            // subtree scan off the common path.
            var relativePath = repository
                .Locate(plugin, new RecordIdentity(formKey, recordType, record.EditorID))
                ?.RelativePath ?? string.Empty;
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
        // The same chain the resolver walks, participation included (ADR-0044): a copy the game does
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

    // Whatever is wrong with the source, the remedy is re-Track (ADR-0042), so the catch is
    // deliberately unfiltered and the message uniform.
    private (IMod? Mod, string? RefusalReason) DeserializeSource(string treeRoot, string pluginName)
    {
        try
        {
            var mod = RecordTextCodecGeneratorSeed
                .DeserializeWholeMod(treeRoot, InlineWorkDropoff.Instance, CancellationToken.None)
                .GetAwaiter().GetResult();
            return (mod, null);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "{Plugin} could not be read from its source", pluginName);

            // A JSON-tree deserialize never touches Mutagen's binary parser, so it never throws a
            // RecordException; the real exception is FilePathedException, whose only identity is the
            // source file path, which FromSourceReadException anchors to.
            var diagnosis = PluginDiagnosis.FromSourceReadException(ex, treeRoot);
            return (null, $"{pluginName} could not be read from its source: {diagnosis.Describe()} Re-Track to regenerate the source.");
        }
    }

    // ADR-0042: the generated deserializer skips an unrecognized property or file without throwing,
    // so a successful parse proves nothing. The check is self-consistency in both directions: a
    // document the regeneration does not produce is content the parse dropped.

    // No live subrecord-inventory gate here, deliberately: that loss class arises only when Track
    // parses an external binary, never from Compile.
    private static string? RefuseIfSourceDoesNotRoundTrip(IMod mod, string pluginName, string resolverRoot)
    {
        var regeneratedFiles = PluginTrees.SerializeToPristineFiles(mod, pluginName).GetAwaiter().GetResult();
        var treeRoot = SourceRepository.RootFor(pluginName);
        var rootHeaderPath = Path.Combine(treeRoot, SourceRepository.RecordDataFileName);

        foreach (var file in regeneratedFiles)
        {
            var onDiskPath = Path.Combine(resolverRoot, file.RelativePath);
            if (File.Exists(onDiskPath) && File.ReadAllBytes(onDiskPath).AsSpan().SequenceEqual(file.Content))
                continue;

            var offender = file.RelativePath == rootHeaderPath ? "the plugin header" : file.RelativePath;
            return $"{pluginName} does not round-trip through its own source: {offender} does not match " +
                "what the current codec would produce from it. Re-Track to regenerate the source.";
        }

        var regeneratedPaths = regeneratedFiles.Select(f => f.RelativePath).ToHashSet(StringComparer.Ordinal);
        var unproduced = Directory
            .EnumerateFiles(Path.Combine(resolverRoot, treeRoot), "*.json", SearchOption.AllDirectories)
            .Select(f => Path.GetRelativePath(resolverRoot, f))
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

/// <summary>Where a plugin's source tree is read from: the working tree's files, or a named ref's
/// blobs written to a same-layout scratch directory, so the whole-mod reader never needs a git
/// checkout.</summary>
internal sealed class SourceCheckout : IDisposable
{
    private readonly string? _scratchRoot;

    private SourceCheckout(string treeRoot, string resolverRoot, string description, string? scratchRoot) =>
        (TreeRoot, ResolverRoot, Description, _scratchRoot) = (treeRoot, resolverRoot, description, scratchRoot);

    /// <summary>The <c>source/&lt;plugin&gt;/</c> directory itself — what the whole-mod reader takes.</summary>
    internal string TreeRoot { get; }

    /// <summary>The parent of <see cref="TreeRoot"/>. Diagnostic paths are stated relative to this, so
    /// they are mod-folder-relative for either source and join cleanly into a Problems-panel URI.</summary>
    internal string ResolverRoot { get; }

    /// <summary>What to call this source in a refusal message.</summary>
    internal string Description { get; }

    internal static SourceCheckout Of(string modFolder, PluginKey plugin, CompileSource source, GameRelease release)
    {
        var treeName = SourceRepository.RootFor(plugin.Name);

        if (source is CompileSource.AtRef atRef)
        {
            // The owner is constructed before a byte is written and populating happens under its own
            // disposal: a throw mid-populate would otherwise happen before the caller's `using` has
            // anything to bind, and the scratch directory would leak.
            var scratchRoot = Directory.CreateTempSubdirectory("medit-compile-ref-").FullName;
            var checkout = new SourceCheckout(
                Path.Combine(scratchRoot, treeName), scratchRoot, atRef.Ref, scratchRoot);
            try
            {
                SourceRepository.Open(modFolder, release)?.MaterializeAtRef(plugin, atRef.Ref, scratchRoot);
            }
            catch
            {
                checkout.Dispose();
                throw;
            }
            return checkout;
        }

        return new SourceCheckout(
            Path.Combine(modFolder, treeName), modFolder, "the working tree", scratchRoot: null);
    }

    public void Dispose()
    {
        if (_scratchRoot == null) return;
        try { Directory.Delete(_scratchRoot, recursive: true); }
        catch (IOException) { /* scratch, best-effort */ }
        catch (UnauthorizedAccessException) { /* scratch, best-effort */ }
    }
}
