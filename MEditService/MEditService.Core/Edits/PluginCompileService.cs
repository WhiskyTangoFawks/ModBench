using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Serialization;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Analysis;
using Mutagen.Bethesda.Plugins.Records;
using Noggog.WorkEngine;

namespace MEditService.Core.Edits;

/// <summary>ADR-0041's Save &amp; Compile: source (working tree or a named git ref) to binary. Reads
/// the source's own bytes, never the DB index; refuses only what it structurally cannot emit, and
/// the rest becomes diagnostics.</summary>
public sealed class PluginCompileService(
    ILoadOrderMirror mirror,
    PluginWriter writer,
    ILogger<PluginCompileService> logger)
{
    public CompileResult Compile(PluginKey plugin, CompileSource source)
    {
        var (resolvedLoadOrder, resolvedIndex, resolvedModFolder, resolvedMetadata, targetRefusal) = ResolveCompileTarget(plugin);
        if (targetRefusal != null)
            return CompileResult.Refused(targetRefusal);
        var (loadOrder, index, modFolder, metadata) = (resolvedLoadOrder!, resolvedIndex!, resolvedModFolder!, resolvedMetadata!);

        // A compile at a named ref reads that ref's tree onto disk first, so both cases below are the
        // same "read this directory" call.
        using var checkout = SourceCheckout.Of(modFolder, plugin.Name, source);
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
        var collidingFormKeys = SourceUnitResolver.FormKeysWithMoreThanOneSourceUnit(
            checkout.TreeRoot, mod.EnumerateMajorRecords().Select(r => r.FormKey));
        if (collidingFormKeys.Count > 0)
        {
            return CompileResult.Refused(
                $"{plugin.Name} cannot be compiled: more than one source file claims the same FormKey — " +
                $"{string.Join(", ", collidingFormKeys)}.");
        }

        var roundTripRefusal = RefuseIfSourceDoesNotRoundTrip(mod, plugin.Name, checkout.ResolverRoot);
        if (roundTripRefusal != null)
            return CompileResult.Refused(roundTripRefusal);

        var diagnostics = CollectDiagnostics(mod, index, plugin, checkout.ResolverRoot, loadOrder.GameRelease);

        var loadOrderNames = loadOrder.Plugins
            .Where(p => p.InLoadOrder)
            .OrderBy(p => p.LoadOrderIndex)
            .Select(p => p.Name)
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
                writer.SaveFromModAsync(mod, metadata.Path, loadOrderNames).GetAwaiter().GetResult();
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
            var binarySha256 = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(metadata.Path)));
            SourceRepository.ParkCompileSnapshot(modFolder, plugin.Name, atRef, binarySha256);
            return true;
        });
        if (writeRefusal != null)
            return CompileResult.Refused(writeRefusal);

        var masters = index.At(RecordRef.Effective).GetEffectiveMasters(plugin);
        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation("Compiled {Plugin} ({Origin}) from {RecordCount} source records",
                plugin.Name, plugin.Origin, mod.EnumerateMajorRecords().Count());
        }
        return CompileResult.Success(diagnostics, masters);
    }

    private (ILoadOrder? LoadOrder, IRecordIndex? Index, string? ModFolder, PluginMetadata? Metadata, string? RefusalReason)
        ResolveCompileTarget(PluginKey plugin)
    {
        var loadOrder = mirror.LoadOrder;
        var index = mirror.Index;
        if (loadOrder == null || index == null)
            return (null, null, null, null, "No load order has been received.");

        var modFolder = ModFolders.TrackedOf(loadOrder, plugin);
        if (modFolder == null)
            return (null, null, null, null, $"{plugin.Name} is not tracked, so there is no source to compile.");

        var metadata = loadOrder.Plugins.FirstOrDefault(p =>
            p.Name.Equals(plugin.Name, StringComparison.OrdinalIgnoreCase)
            && p.Origin.Equals(plugin.Origin, StringComparison.OrdinalIgnoreCase));
        if (metadata == null)
            return (null, null, null, null, $"{plugin.Name} is not in the load order.");

        return (loadOrder, index, modFolder, metadata, null);
    }

    // Reads the CheckError the editor already shows per field rather than re-deriving it, so the two
    // cannot drift. Walks the mod, not the files, so embedded children report too.
    private static List<CompileDiagnostic> CollectDiagnostics(
        IMod mod, IRecordIndex index, PluginKey plugin, string resolverRoot, GameRelease gameRelease)
    {
        var diagnostics = new List<CompileDiagnostic>();
        // One bulk read rather than a point-read per record: two DuckDB queries each, most of
        // Compile's wall clock on a 3,940-record fixture.
        var reads = index.At(RecordRef.Effective);
        var documents = reads.GetDocuments(plugin).ToDictionary(d => d.FormKey);
        // One resolution cache for the pass: SourceUnitResolver re-scanning the tree per record dominated.
        var resolutionCache = new SourceUnitResolutionCache();
        foreach (var record in mod.EnumerateMajorRecords())
        {
            var formKey = record.FormKey.ToString();
            if (!documents.TryGetValue(formKey, out var document)) continue;

            var errors = document.Fields
                .Where(f => f.CheckError != null)
                .Select(f => $"{f.Metadata.Name}: {f.CheckError}")
                .ToList();
            if (errors.Count == 0) continue;

            // Only records with something to report pay for resolution, which keeps a container's
            // subtree scan off the common path.
            var relativePath = SourceUnitResolver
                .Resolve(reads, plugin, resolverRoot, formKey, document.RecordType, document.EditorId, gameRelease, resolutionCache)
                ?.RelativePath ?? string.Empty;
            diagnostics.AddRange(errors.Select(message => new CompileDiagnostic(formKey, relativePath, message)));
        }
        return diagnostics;
    }

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

    // ADR-0042: the generated deserializer skips an unrecognized property and defaults a missing one
    // without throwing, so a successful parse proves nothing. With no independent original here, the
    // check is self-consistency: regenerate and byte-compare.

    // No live subrecord-inventory gate here, deliberately: that loss class arises only when Track
    // parses an external binary, never from Compile.
    private static string? RefuseIfSourceDoesNotRoundTrip(IMod mod, string pluginName, string resolverRoot)
    {
        var regeneratedFiles = TrackService.SerializeToPristineFiles(mod, pluginName).GetAwaiter().GetResult();
        var rootHeaderPath = Path.Combine(SourceRecordPath.RootFor(pluginName), SourceUnitResolver.RecordDataFileName);

        foreach (var file in regeneratedFiles)
        {
            var onDiskPath = Path.Combine(resolverRoot, file.RelativePath);
            if (File.Exists(onDiskPath) && File.ReadAllBytes(onDiskPath).AsSpan().SequenceEqual(file.Content))
                continue;

            var offender = file.RelativePath == rootHeaderPath ? "the plugin header" : file.RelativePath;
            return $"{pluginName} does not round-trip through its own source: {offender} does not match " +
                "what the current codec would produce from it. Re-Track to regenerate the source.";
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

    internal static SourceCheckout Of(string modFolder, string pluginName, CompileSource source)
    {
        var treeName = SourceRecordPath.RootFor(pluginName);

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
                foreach (var (relativePath, bytes) in SourceRepository.EnumerateSourceAtRef(modFolder, pluginName, atRef.Ref))
                {
                    var destination = Path.Combine(scratchRoot, relativePath);
                    Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
                    File.WriteAllBytes(destination, bytes);
                }
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
