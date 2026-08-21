using MEditService.Core.Records;
using MEditService.Core.Serialization;
using MEditService.Core.Session;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Edits;

/// <summary>
/// ADR-0041's Save &amp; Compile, end to end (#416 pinned contract): serializes a plugin's source
/// (working tree, or a named git ref) to its binary through the journaled write pipeline. Compile
/// derives what the format forces (masters, container structure) and refuses only what it
/// structurally cannot emit; everything else it can still write becomes a diagnostic, not a refusal.
///
/// <para>The single write path's other half: <see cref="RecordEditService"/> is source text ←
/// working tree; this is source text → binary. Both read the source's own bytes, never the DB index,
/// for the same reason — the index and the source are not always structurally identical (#369's
/// measured hole) — except for <b>containment</b>, which this class deliberately reads from the
/// index (<see cref="ContainerAssembler"/>), because nothing in this arc lets a user edit it and the
/// source was never asked to carry it (#416 S1b / Q1).</para>
/// </summary>
public sealed class PluginCompileService(
    ISessionManager sessions,
    PluginWriter writer,
    ILogger<PluginCompileService> logger)
{
    private readonly RecordTextCodec _codec = new(Microsoft.Extensions.Logging.Abstractions.NullLogger<RecordTextCodec>.Instance);

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

        var sourceFiles = EnumerateSource(modFolder, plugin.Name, source);
        var recordsByFormKey = new Dictionary<string, IMajorRecord>(StringComparer.Ordinal);
        var pathsByFormKey = new Dictionary<string, string>(StringComparer.Ordinal);
        var collidingFormKeys = new List<string>();
        foreach (var (relativePath, bytes) in sourceFiles)
        {
            // #451: the root header (Track's own free "no source file" fix, ADR-0041's #444 amendment)
            // and the auto-persisted spriggit-meta.json sidecar are real files directly under
            // "<plugin>.source/", not records — feeding either to the codec below is not "an
            // unresolvable type" (the loud, attributable #454 case immediately after this), it is not
            // a record at all, and asking it to self-describe crashes the generated dispatch outright
            // (NullReferenceException from GetSimpleName on a document with no MutagenObjectType field
            // to read). Skipped explicitly, by the same two names Track itself writes — not a general
            // "ignore anything that fails to parse" rule, so a genuine container path still reaches the
            // codec and fails loudly two lines down.
            if (IsRootSidecarOrHeader(relativePath)) continue;

            // #450/#451: a source document only names its own type when its path could not, so the
            // type comes from the path — the group-folder segment SourceRecordPath.For itself wrote,
            // which resolves to the same string the index's record_type column carries. A path this
            // *flat* layout could not have produced (any container path — Cells/Worldspaces/Quests)
            // also yields null here; that is #453/#454's structure to read, not this loop's, and it
            // fails loudly below (the codec's own named exception) rather than silently guessing.
            var recordType = SourceRecordPath.TryParse(relativePath, session.GameRelease, out var identity) ? identity.RecordType : null;
            var record = _codec.DeserializeFromBytesAsync(bytes, session.GameRelease, recordType).GetAwaiter().GetResult();
            var formKey = record.FormKey.ToString();
            // Structurally impossible to emit: two distinct source files both claiming the same
            // FormKey (a hand-edit, a corrupted rename, a renumber that collided) would collapse to
            // one binary record, silently discarding whichever this dictionary assignment overwrites
            // — refuse rather than pick a winner (#416 comment 2 on the issue: compile refuses states
            // it cannot emit without changing FormKeys, naming the collision).
            if (recordsByFormKey.ContainsKey(formKey)) collidingFormKeys.Add(formKey);
            recordsByFormKey[formKey] = record;
            pathsByFormKey[formKey] = relativePath;
        }
        if (collidingFormKeys.Count > 0)
        {
            return CompileResult.Refused(
                $"{plugin.Name} cannot be compiled: more than one source file claims the same FormKey — " +
                $"{string.Join(", ", collidingFormKeys.Distinct(StringComparer.Ordinal))}.");
        }

        var mod = ModFactory.Activator(ModKey.FromFileName(plugin.Name), session.GameRelease);
        var assembled = ContainerAssembler.Assemble(mod, recordsByFormKey, index, plugin);
        if (assembled.UnplaceableFormKeys.Count > 0)
        {
            return CompileResult.Refused(
                $"{plugin.Name} cannot be compiled: no parent slot found for " +
                $"{string.Join(", ", assembled.UnplaceableFormKeys)}.");
        }

        // Semantic breakage compiles successfully with diagnostics (dangling/type-mismatched
        // FormLinks and kin) — the same CheckErrorBuilder-driven CheckError the editor already shows
        // per field (DuckDbRecordIndex.GetDocument), read here rather than re-derived, so "what the
        // editor flags" and "what compile reports" can't drift.
        var diagnostics = new List<CompileDiagnostic>();
        foreach (var formKey in recordsByFormKey.Keys)
        {
            var document = index.GetDocument(formKey, plugin);
            if (document == null) continue;
            foreach (var field in document.Fields)
            {
                if (field.CheckError is { } error)
                    diagnostics.Add(new CompileDiagnostic(formKey, pathsByFormKey[formKey], $"{field.Metadata.Name}: {error}"));
            }
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
            plugin.Name, plugin.Origin, recordsByFormKey.Count);
        return CompileResult.Success(diagnostics, masters);
    }

    // Working tree: the plain files on disk under "<plugin>.source/**" — no git involved, the same
    // way RecordEditService reads a single record's source file. #416 S8 adds the AtRef case: a git
    // ref's tree read through SourceRepository, no checkout.
    private static IReadOnlyList<(string RelativePath, byte[] Bytes)> EnumerateSource(
        string modFolder, string pluginName, CompileSource source)
    {
        return source switch
        {
            CompileSource.WorkingTree => EnumerateWorkingTreeSource(modFolder, pluginName),
            CompileSource.AtRef atRef => SourceRepository.EnumerateSourceAtRef(modFolder, pluginName, atRef.Ref),
            _ => throw new ArgumentOutOfRangeException(nameof(source), source, "Unknown compile source."),
        };
    }

    private static List<(string RelativePath, byte[] Bytes)> EnumerateWorkingTreeSource(
        string modFolder, string pluginName)
    {
        var sourceDir = Path.Combine(modFolder, $"{pluginName}{SourceRecordPath.SourceSuffix}");
        if (!Directory.Exists(sourceDir)) return [];

        // Relative to modFolder, matching EnumerateSourceAtRef's own shape — CompileDiagnostic.
        // SourceRelativePath is a path the extension joins against the mod folder to build a
        // Problems-panel URI, in both CompileSource cases alike, never an absolute path from one and
        // relative from the other.
        return Directory.EnumerateFiles(sourceDir, "*.json", SearchOption.AllDirectories)
            .Select(path => (Path.GetRelativePath(modFolder, path), File.ReadAllBytes(path)))
            .ToList();
    }

    // "<plugin>.source/RecordData.json" (the mod header), "<plugin>.source/spriggit-meta.json" (the
    // auto-persisted sidecar) or "<plugin>.source/.spriggit" (the CLI pin file) — exactly two segments,
    // all three names Track itself writes at the tree root (TrackService.cs,
    // SpriggitRootHeader/SpriggitMetaSidecar/SpriggitConfigSidecar). Deliberately name-based, not
    // "anything TryParse rejects": a nested RecordData.json (a Cell/Quest's own document) must still
    // reach the codec and fail loudly, not be silently swept up by a broader rule.
    //
    // ".spriggit" only ever reaches this loop via CompileSource.AtRef — EnumerateWorkingTreeSource's
    // own "*.json" glob already excludes it (its name has no .json extension at all), but
    // SourceRepository.EnumerateSourceAtRef's `git ls-tree -r` walks every blob under the source
    // prefix with no extension filter, so the two CompileSource cases are not otherwise symmetric here
    // — caught running PluginCompileServiceParkedRefTests' own AtRef case.
    private static bool IsRootSidecarOrHeader(string relativePath)
    {
        var segments = relativePath.Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries);
        if (segments.Length != 2) return false;

        var fileName = segments[1];
        return fileName.Equals("RecordData.json", StringComparison.Ordinal)
            || fileName.Equals(SpriggitMetaSidecar.FileName, StringComparison.Ordinal)
            || fileName.Equals(SpriggitConfigSidecar.FileName, StringComparison.Ordinal);
    }
}
