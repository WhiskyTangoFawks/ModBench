using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Serialization;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;
using Noggog.WorkEngine;

namespace MEditService.Core.Edits;

/// <summary>
/// ADR-0041's Save &amp; Compile, end to end: serializes a plugin's source
/// (working tree, or a named git ref) to its binary through the journaled write pipeline. Compile
/// derives what the format forces (masters) and refuses only what it structurally cannot emit;
/// everything else it can still write becomes a diagnostic, not a refusal.
///
/// <para>The single write path's other half: <see cref="RecordEditService"/> is source text ←
/// working tree; this is source text → binary. Both read the source's own bytes, never the DB index —
/// the index and the source are not always structurally identical.</para>
///
/// <para><b>Containment is the path (ADR-0041).</b> The tree's own directory nesting
/// (<c>Cells/&lt;b&gt;/&lt;sb&gt;/…</c>, <c>Worldspaces/&lt;ws&gt;/&lt;X, Y&gt;/&lt;X, Y&gt;/…</c>,
/// <c>Quests/&lt;q&gt;/DialogTopics/…</c>) already <i>is</i> the containment, and the generated
/// whole-mod reader walks it — never the DB's own <c>placement</c>/<c>cell_location</c>/
/// <c>container_child</c> rows. The root <c>RecordData.json</c> comes with it, so the compiled binary
/// carries the source's own mod header rather than a freshly minted empty one.</para>
///
/// <para><b>This is a designated door</b> for the generated whole-mod mixin, alongside
/// <see cref="TrackService"/> (write) and <see cref="SourceIngest"/> (read) —
/// <see cref="RecordTextCodecGeneratorSeed"/>'s whitelist, enforced by
/// <c>RecordTextCodecGeneratorSeedTests</c>. It shares <see cref="SourceIngest"/>'s reader rather than
/// having one of its own: both go through the same gateway, over the same tree, with the same
/// sequential dropoff, so there is no second reader to drift from the first.</para>
///
/// <para><b>Child order is preserved, and can be claimed.</b>
/// <c>RecordTextCodecCustomization</c> turns <c>Overall.EnforceRecordOrder</c> on, so every
/// folder-split sibling's file name carries its real GRUP position and a compile reproduces it —
/// verified byte-for-byte on the committed fixture (<c>CompileRoundTripGateTests</c>,
/// <c>DialogueOrderDamageTests</c>).</para>
/// </summary>
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
        // same "read this directory" call. Once this returns, `using` disposes the scratch on every
        // path out — refusal and throw alike; a failure *during* the read cleans up on its own way out
        // (SourceCheckout.Of), which is a separate window and was not free.
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

        // Structurally impossible to emit: two source units both claiming one FormKey (a hand-edit, an
        // interrupted rename, a third-party tool's copy) can only become one binary record, silently
        // discarding the other — refuse rather than pick a winner, naming the collision. Asked of the
        // tree, not of `mod`: the reader's own FormKey-keyed group cache has already resolved a
        // same-folder collision by the time `mod` exists (SourceUnitResolver.FormKeysWithMoreThanOneSourceUnit).
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

        // Every compile runs through the journal, batch of one — the marker names
        // this plugin before the binary write below begins, and is cleared only once the whole batch
        // (here, the one plugin) has landed. Everything above this point is pure computation/refusal
        // with nothing on disk for a crash to leave ambiguous; from here on, a crash mid-flight is
        // exactly what the marker is for. compileOne is deliberately not wrapped in a try/catch —
        // an exception from the write propagates out of RunBatch (and out of this method)
        // with the marker left exactly as CompileJournal.WriteMarker last wrote it, the same
        // observable state a real crash leaves, which is what UnfinishedBatch reads back —
        // except for the one named Kind A shape below, which CompileJournal's own
        // doc comment already treats as a first-class outcome: compileOne returning false is
        // "indistinguishable [from a crash] to a reader" by design, so converting that one write
        // failure into a `false` return (captured as a refusal message in the closure below) uses
        // the mechanism this class already offers rather than adding a new one. PluginWriter never
        // touches the real plugin file until Commit() — a mid-write throw here leaves it exactly as
        // it was, so refusing instead of leaving the crash-shaped marker is safe.
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
                // Same Kind A shape as TrackService.VerifyRoundTrip's own catch — a struct-
                // list script property's FormLink is invisible to Mutagen's EnumerateFormLinks
                // (Mutagen-Modding/Mutagen#688), so the content-derived master pass (ADR-0038)
                // prunes a master this write still needs. Every other write failure still
                // propagates raw below, unchanged.
                writeRefusal = $"{plugin.Name} could not be compiled: {PluginDiagnosis.FromWriteException(ex).Describe()}";
                return false;
            }

            // The parked snapshot advances only after the binary write above has landed — never
            // before, never on a refused compile. An AtRef compile parks too:
            // without this, the self-echo suppression breaks the moment a pristine restore runs —
            // the binary changes to the ref's bytes while the parked trailer still names the old
            // working-tree hash, so Modbench's own write would read as an external change.
            var binarySha256 = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(metadata.Path)));
            SourceRepository.ParkCompileSnapshot(modFolder, plugin.Name, atRef, binarySha256);
            return true;
        });
        if (writeRefusal != null)
            return CompileResult.Refused(writeRefusal);

        var masters = index.GetEffectiveMasters(plugin);
        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation("Compiled {Plugin} ({Origin}) from {RecordCount} source records",
                plugin.Name, plugin.Origin, mod.EnumerateMajorRecords().Count());
        }
        return CompileResult.Success(diagnostics, masters);
    }

    /// <summary>
    /// The three checks that establish there is a source to compile at all: a load order, a tracked mod
    /// folder for <paramref name="plugin"/>, and that plugin's own metadata within the load order.
    /// </summary>
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

    /// <summary>
    /// Semantic breakage compiles successfully with diagnostics (dangling/type-mismatched FormLinks
    /// and kin) — the same <c>CheckErrorBuilder</c>-driven <c>CheckError</c> the editor already shows
    /// per field (<c>DuckDbRecordIndex.GetDocument</c>), read here rather than re-derived, so "what
    /// the editor flags" and "what compile reports" can't drift.
    ///
    /// <para>Walks the mod, not the source files, so embedded children (placed refs, navmeshes,
    /// landscape, a worldspace's TopCell) — which have no file of their own — report too, against
    /// the container document that holds them.</para>
    /// </summary>
    private static List<CompileDiagnostic> CollectDiagnostics(
        IMod mod, IRecordIndex index, PluginKey plugin, string resolverRoot, GameRelease gameRelease)
    {
        var diagnostics = new List<CompileDiagnostic>();
        // One bulk read rather than a point-read per record — two DuckDB queries each, most of
        // Compile's wall clock on a real 3,940-record fixture. The loop still
        // walks the mod (not the fetched set) so diagnostic order stays the mod's own enumeration
        // order, and a record the index doesn't hold still skips.
        var documents = index.GetDocuments(plugin).ToDictionary(d => d.FormKey);
        // And one resolution cache for the pass: the dominant cost was never the document fetch but
        // SourceUnitResolver re-scanning the tree once per reporting record (see the cache's own doc).
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

            // The record's own source unit, resolved the one way this codebase resolves one —
            // a flat record's computed path, a container's own directory, or, for an embedded child,
            // the parent document that actually holds it. Only records that have something to report
            // pay for it, which is what keeps a container's subtree scan off the common path.
            var relativePath = SourceUnitResolver
                .Resolve(index, plugin, resolverRoot, formKey, document.RecordType, document.EditorId, gameRelease, resolutionCache)
                ?.RelativePath ?? string.Empty;
            diagnostics.AddRange(errors.Select(message => new CompileDiagnostic(formKey, relativePath, message)));
        }
        return diagnostics;
    }

    /// <summary>
    /// ADR-0042: whatever is wrong with the source — a hand edit that breaks the
    /// JSON, external corruption, a codec change the tree predates — the remedy is always the same
    /// (re-Track), so the message is uniform regardless of which internal exception shape the
    /// deserializer happens to throw for a given kind of damage. Deliberately unfiltered, the same
    /// way <see cref="RecordEditService"/>'s own cascade catch is: the failure surface is
    /// "whatever the JSON/Mutagen layers throw for input they cannot read", not one exception type.
    /// </summary>
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

            // This seam's own exception vocabulary is not Track's — a JSON-tree deserialize
            // never touches Mutagen's binary parser, so it never throws a RecordException at all
            // (confirmed live with a forged corrupt-FormKey-string fixture: the real exception is
            // Mutagen.Bethesda.Serialization.Exceptions.FilePathedException, whose only identity is
            // the source file path). PluginDiagnosis.FromSourceReadException anchors to that file
            // instead, the same identity unit RefuseIfSourceDoesNotRoundTrip below already uses.
            var diagnosis = PluginDiagnosis.FromSourceReadException(ex, treeRoot);
            return (null, $"{pluginName} could not be read from its source: {diagnosis.Describe()} Re-Track to regenerate the source.");
        }
    }

    /// <summary>
    /// ADR-0042: does this source, once understood by the codec, faithfully
    /// reproduce itself? Deserializing above can succeed while quietly losing data — the generated
    /// deserializer skips an unrecognized property and
    /// leaves a missing-but-expected one at its default, neither ever throwing (confirmed by spike)
    /// — so a successful parse is not itself evidence the source was read correctly.
    ///
    /// <para>Unlike <see cref="TrackService"/>'s own round-trip gate, there is no
    /// independent "original" to check <paramref name="mod"/> against here — the source text is the
    /// only ground truth compile has, which is ADR-0042's own premise. So the check is
    /// self-consistency, not identity: regenerate canonical text from <paramref name="mod"/> and
    /// byte-compare it against what is actually on disk. A silently dropped or defaulted field never
    /// round-trips this way — the regenerated file omits what the on-disk file still carries — which
    /// is where that surfaces, rather than as a wrong binary with no signal at all. Naming follows
    /// the same shape as Track's gate (byte identity is the check; naming the offender is a second,
    /// separate step only paid for on failure) but names the differing source file's own path rather
    /// than a record via <c>Equals</c> — there is no independent object to compare against here
    /// either, only the regenerated text and the real text.</para>
    ///
    /// <para>A structural write's own group-folder
    /// renormalization (<see cref="SourceUnitResolver.RenormalizeGroupOrder"/>) is what keeps a
    /// gap-leaving delete/renumber from ever reaching this comparison mismatched — this method's own
    /// comparison is byte-exact and per-path. One case it correctly refuses
    /// because of that: a crash mid-renormalization, which leaves a group folder half-renumbered —
    /// this gate catches that the same way it catches any other genuine divergence, pointing at
    /// re-Track, with no separate recovery machinery.</para>
    ///
    /// <para><b>The subrecord-inventory check gets no live gate here, deliberately — not an
    /// oversight.</b> That check (<see cref="PluginBinaryWalk.FindFirstSubrecordLoss"/>, wired into
    /// <see cref="TrackService.VerifyRoundTrip"/>) needs the same "independent original" this method's
    /// own doc comment above says Compile doesn't have — every candidate "before" binary at Compile
    /// time (the plugin's current on-disk bytes, an older Track-time snapshot) is exactly as
    /// indistinguishable from a legitimate field-clear edit as this method's own text-level check
    /// would be, and picking an older baseline doesn't fix that, it just moves the same ambiguity back
    /// one hop. That is also why Compile does not need one: that loss class is introduced
    /// only when an external binary is *deserialized* — Track's own parse — never by Compile, which
    /// only ever writes from a source that already passed
    /// this method's own self-consistency check. Once Track's gate refuses a plugin carrying that
    /// defect, no Compile downstream of a successful Track can encounter it — the source cannot hold
    /// what the model never captured. Compile's obligation is satisfied by sharing the one walker, not
    /// by a second live check.</para>
    /// </summary>
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

/// <summary>
/// The directory <see cref="PluginCompileService"/> reads a plugin's source tree from, for either
/// <see cref="CompileSource"/>.
///
/// <para>The working tree is the plain files on disk under <c>source/&lt;plugin&gt;/</c> — no git
/// involved, the same way <see cref="RecordEditService"/> reads a single record's source file. A named
/// ref is that ref's blobs written into a scratch directory laid out identically, so the
/// whole-mod reader — which takes a folder, not a byte stream — can read it without a checkout: HEAD,
/// the current branch and the edit branch's own working tree all stay exactly where they were, which is
/// what <c>PluginCompileServiceParkedRefTests</c> pins.</para>
/// </summary>
internal sealed class SourceCheckout : IDisposable
{
    private readonly string? _scratchRoot;

    private SourceCheckout(string treeRoot, string resolverRoot, string description, string? scratchRoot) =>
        (TreeRoot, ResolverRoot, Description, _scratchRoot) = (treeRoot, resolverRoot, description, scratchRoot);

    /// <summary>The <c>source/&lt;plugin&gt;/</c> directory itself — what the whole-mod reader takes.</summary>
    internal string TreeRoot { get; }

    /// <summary>Its parent — the mod folder for a working-tree compile, the scratch root for a ref.
    /// <see cref="SourceUnitResolver"/> and <c>CompileDiagnostic.SourceRelativePath</c> are both stated
    /// relative to this, so a diagnostic's path is the same mod-folder-relative text either way, which
    /// is what the extension joins against the mod folder to build a Problems-panel URI.</summary>
    internal string ResolverRoot { get; }

    /// <summary>What to call this source in a refusal message.</summary>
    internal string Description { get; }

    internal static SourceCheckout Of(string modFolder, string pluginName, CompileSource source)
    {
        var treeName = SourceRecordPath.RootFor(pluginName);

        if (source is CompileSource.AtRef atRef)
        {
            // The owner is constructed *before* a single byte is written, and populating happens under
            // its own disposal. Ordering, not style: materialising first and constructing afterwards
            // would mean a throw mid-populate happens before the caller's `using` has anything to bind,
            // so Dispose never runs and the scratch directory leaks — permanently, and again on every
            // retry. Real failures live in that window (disk full, permissions, a path the filesystem
            // rejects, another tool touching it mid-write — root CLAUDE.md's
            // never-assume-exclusive-ownership rule applied to paths this process did not choose), and
            // PluginCompileServiceParkedRefTests pins the cleanup with one of them.
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
