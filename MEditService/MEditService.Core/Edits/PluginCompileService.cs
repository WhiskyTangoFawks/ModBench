using MEditService.Core.Records;
using MEditService.Core.Serialization;
using MEditService.Core.Session;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda.Plugins.Records;
using Noggog.WorkEngine;

namespace MEditService.Core.Edits;

/// <summary>
/// ADR-0041's Save &amp; Compile, end to end (#416 pinned contract): serializes a plugin's source
/// (working tree, or a named git ref) to its binary through the journaled write pipeline. Compile
/// derives what the format forces (masters) and refuses only what it structurally cannot emit;
/// everything else it can still write becomes a diagnostic, not a refusal.
///
/// <para>The single write path's other half: <see cref="RecordEditService"/> is source text ←
/// working tree; this is source text → binary. Both read the source's own bytes, never the DB index —
/// the index and the source are not always structurally identical (#369's measured hole).</para>
///
/// <para><b>Containment is the path (#454, ADR-0041's #444 amendment).</b> This used to read every
/// source file one at a time and hand the flat result to <c>ContainerAssembler</c>, which rebuilt the
/// mod's real containment from the DB's own <c>placement</c>/<c>cell_location</c>/<c>container_child</c>
/// rows. It no longer does, and the assembler is gone: the tree's own directory nesting
/// (<c>Cells/&lt;b&gt;/&lt;sb&gt;/…</c>, <c>Worldspaces/&lt;ws&gt;/&lt;X, Y&gt;/&lt;X, Y&gt;/…</c>,
/// <c>Quests/&lt;q&gt;/DialogTopics/…</c>) already <i>is</i> the containment, and the generated
/// whole-mod reader walks it. The root <c>RecordData.json</c> comes with it, so the compiled binary
/// carries the source's own mod header rather than a freshly minted empty one.</para>
///
/// <para><b>This is a designated door</b> for the generated whole-mod mixin, alongside
/// <see cref="TrackService"/> (write) and <see cref="SourceIngest"/> (read) —
/// <see cref="RecordTextCodecGeneratorSeed"/>'s AC2 whitelist, enforced by
/// <c>RecordTextCodecGeneratorSeedTests</c>. It shares <see cref="SourceIngest"/>'s reader rather than
/// having one of its own: both go through the same gateway, over the same tree, with the same
/// sequential dropoff, so there is no second reader to drift from the first.</para>
///
/// <para><b>Child order is not preserved and must not be claimed.</b> Spriggit's layout carries none —
/// its reader sorts on a <c>"[N] "</c> file-name prefix written only under
/// <c>Overall.EnforceRecordOrder</c>, which neither this project nor Spriggit enables — so a compiled
/// binary's folder-split children come back in filesystem order, not the original binary's GRUP order.
/// #454's scope item 4 accepts that (the gate is compile→re-serialize text stability, not byte identity
/// with the pre-Track binary); for FO4 <c>DialogTopic.Responses</c> it is real semantic loss, tracked
/// as #459.</para>
/// </summary>
public sealed class PluginCompileService(
    ISessionManager sessions,
    PluginWriter writer,
    ILogger<PluginCompileService> logger)
{
    public CompileResult Compile(PluginKey plugin, CompileSource source)
    {
        var session = sessions.Session;
        var index = sessions.Index;
        if (session == null || index == null)
            return CompileResult.Refused("No session is loaded.");

        var modFolder = ModFolders.TrackedOf(session, plugin);
        if (modFolder == null)
            return CompileResult.Refused($"{plugin.Name} is not tracked, so there is no source to compile.");

        var metadata = session.Plugins.FirstOrDefault(p =>
            p.Name.Equals(plugin.Name, StringComparison.OrdinalIgnoreCase)
            && p.Origin.Equals(plugin.Origin, StringComparison.OrdinalIgnoreCase));
        if (metadata == null)
            return CompileResult.Refused($"{plugin.Name} is not part of the loaded session.");

        // A compile at a named ref reads that ref's tree onto disk first, so both cases below are the
        // same "read this directory" call. Disposed on every path out, refusal and throw alike.
        using var checkout = SourceCheckout.Of(modFolder, plugin.Name, source);
        if (!Directory.Exists(checkout.TreeRoot))
        {
            return CompileResult.Refused(
                $"{plugin.Name} has no source tree at {checkout.Description}, so there is nothing to compile.");
        }

        var mod = RecordTextCodecGeneratorSeed
            .DeserializeWholeMod(checkout.TreeRoot, InlineWorkDropoff.Instance, CancellationToken.None)
            .GetAwaiter().GetResult();

        // Structurally impossible to emit: two source units both claiming one FormKey (a hand-edit, an
        // interrupted rename, a third-party tool's copy) can only become one binary record, silently
        // discarding the other — refuse rather than pick a winner (#416 comment 2 on the issue: compile
        // refuses states it cannot emit without changing FormKeys, naming the collision). Asked of the
        // tree, not of `mod`: the reader's own FormKey-keyed group cache has already resolved a
        // same-folder collision by the time `mod` exists (SourceUnitResolver.FormKeysWithMoreThanOneSourceUnit).
        var collidingFormKeys = SourceUnitResolver.FormKeysWithMoreThanOneSourceUnit(
            checkout.TreeRoot, mod.EnumerateMajorRecords().Select(r => r.FormKey));
        if (collidingFormKeys.Count > 0)
        {
            return CompileResult.Refused(
                $"{plugin.Name} cannot be compiled: more than one source file claims the same FormKey — " +
                $"{string.Join(", ", collidingFormKeys.Distinct(StringComparer.Ordinal))}.");
        }

        // Semantic breakage compiles successfully with diagnostics (dangling/type-mismatched
        // FormLinks and kin) — the same CheckErrorBuilder-driven CheckError the editor already shows
        // per field (DuckDbRecordIndex.GetDocument), read here rather than re-derived, so "what the
        // editor flags" and "what compile reports" can't drift.
        var diagnostics = new List<CompileDiagnostic>();
        foreach (var record in mod.EnumerateMajorRecords())
        {
            var formKey = record.FormKey.ToString();
            var document = index.GetDocument(formKey, plugin);
            if (document == null) continue;

            var errors = document.Fields
                .Where(f => f.CheckError != null)
                .Select(f => $"{f.Metadata.Name}: {f.CheckError}")
                .ToList();
            if (errors.Count == 0) continue;

            // The record's own source unit, resolved the one way this codebase resolves one (#453) —
            // a flat record's computed path, a container's own directory, or, for an embedded child,
            // the parent document that actually holds it. Only records that have something to report
            // pay for it, which is what keeps a container's subtree scan off the common path.
            var relativePath = SourceUnitResolver
                .Resolve(index, plugin, checkout.ResolverRoot, formKey, document.RecordType, document.EditorId, session.GameRelease)
                ?.RelativePath ?? string.Empty;
            diagnostics.AddRange(errors.Select(message => new CompileDiagnostic(formKey, relativePath, message)));
        }

        var loadOrder = session.Plugins
            .Where(p => p.InLoadOrder)
            .OrderBy(p => p.LoadOrderIndex)
            .Select(p => p.Name)
            .ToList();

        // #416 S9 (review): every compile runs through the journal, batch of one — the marker names
        // this plugin before the binary write below begins, and is cleared only once the whole batch
        // (here, the one plugin) has landed. Everything above this point is pure computation/refusal
        // with nothing on disk for a crash to leave ambiguous; from here on, a crash mid-flight is
        // exactly what the marker is for. compileOne is not wrapped in a try/catch: an exception from
        // the write propagates out of RunBatch (and out of this method) with the marker left exactly
        // as CompileJournal.WriteMarker last wrote it — the same observable state a real crash leaves,
        // which is what PendingRecovery reads back for #381/#417.
        var atRef = source is CompileSource.AtRef atRefSource ? atRefSource.Ref : null;
        CompileJournal.RunBatch(modFolder, [plugin.Name], _ =>
        {
            writer.SaveFromModAsync(mod, metadata.Path, loadOrder).GetAwaiter().GetResult();

            // #416 S7/S8: the ref advances only after the binary write above has landed — never
            // before, never on a refused compile. An AtRef compile parks too (go-ahead note 1):
            // without this, #417's self-echo suppression breaks the moment a pristine restore runs —
            // the binary changes to the ref's bytes while the parked trailer still names the old
            // working-tree hash, so Modbench's own write would read as an external change.
            var binarySha256 = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(metadata.Path)));
            SourceRepository.ParkCompileSnapshot(modFolder, plugin.Name, atRef, binarySha256);
            return true;
        });

        var masters = index.GetEffectiveMasters(plugin);
        logger.LogInformation("Compiled {Plugin} ({Origin}) from {RecordCount} source records",
            plugin.Name, plugin.Origin, mod.EnumerateMajorRecords().Count());
        return CompileResult.Success(diagnostics, masters);
    }
}

/// <summary>
/// The directory <see cref="PluginCompileService"/> reads a plugin's source tree from, for either
/// <see cref="CompileSource"/>.
///
/// <para>The working tree is the plain files on disk under <c>&lt;plugin&gt;.source/</c> — no git
/// involved, the same way <see cref="RecordEditService"/> reads a single record's source file. A named
/// ref (#416 S8) is that ref's blobs written into a scratch directory laid out identically, so the
/// whole-mod reader — which takes a folder, not a byte stream — can read it without a checkout: HEAD,
/// the current branch and the edit branch's own working tree all stay exactly where they were, which is
/// what <c>PluginCompileServiceParkedRefTests</c> pins.</para>
/// </summary>
internal sealed class SourceCheckout : IDisposable
{
    private readonly string? _scratchRoot;

    private SourceCheckout(string treeRoot, string resolverRoot, string description, string? scratchRoot) =>
        (TreeRoot, ResolverRoot, Description, _scratchRoot) = (treeRoot, resolverRoot, description, scratchRoot);

    /// <summary>The <c>&lt;plugin&gt;.source/</c> directory itself — what the whole-mod reader takes.</summary>
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
        var treeName = $"{pluginName}{SourceRecordPath.SourceSuffix}";

        if (source is CompileSource.AtRef atRef)
        {
            var scratchRoot = Directory.CreateTempSubdirectory("medit-compile-ref-").FullName;
            foreach (var (relativePath, bytes) in SourceRepository.EnumerateSourceAtRef(modFolder, pluginName, atRef.Ref))
            {
                var destination = Path.Combine(scratchRoot, relativePath);
                Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
                File.WriteAllBytes(destination, bytes);
            }
            return new SourceCheckout(
                Path.Combine(scratchRoot, treeName), scratchRoot, atRef.Ref, scratchRoot);
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
