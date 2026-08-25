using System.Security.Cryptography;
using System.Text;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Source;

/// <summary>
/// #417's "Keep as My Edit" exit path: the externally-changed binary at <paramref name="pluginPath"/>
/// lands as working-tree dirt on exactly the records it actually touched — never a wholesale
/// re-serialize like <see cref="ExternalChangeAbsorber.Absorb"/>, because landing here must not
/// clobber the user's own unrelated working-tree edits.
///
/// <para><b>Detection is three-way, git's own checkout-over-dirt rule restated per record.</b> For
/// each record: <c>baseline</c> is the parked ref's own snapshot (the last binary state Modbench
/// knew), <c>incoming</c> is what the just-observed binary deep-parses to, and <c>current</c> is the
/// working tree right now. A record the external binary didn't actually touch
/// (<c>incoming == baseline</c>) is left alone. A record it did touch lands as dirt — unless the user
/// already has independent dirt there too (<c>current != baseline</c>) that doesn't already happen to
/// agree with the incoming value (<c>current != incoming</c>): that is the collision, and it refuses
/// the <b>whole</b> Keep gesture rather than silently discarding the user's edit on just that one
/// record.</para>
/// </summary>
public static class ExternalChangeEditLander
{
    public static ExternalChangeLandResult Keep(
        string modFolder, PluginKey plugin, string pluginPath, GameRelease gameRelease, IRecordReads reads,
        ISchemaReflector reflector, ILogger? logger = null)
    {
        logger ??= NullLogger.Instance;
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var schemas = reflector.GetSchemas(gameRelease);
        var pluginName = plugin.Name;

        var parkedRef = $"refs/medit/last-compile/{pluginName}";
        var baselineByPath = SourceRepository.EnumerateSourceAtRef(modFolder, pluginName, parkedRef)
            .ToDictionary(f => ToGitPath(f.RelativePath), f => Encoding.UTF8.GetString(f.Bytes), StringComparer.Ordinal);

        var deepParsed = ModFactory.ImportSetter(new ModPath(ModKey.FromFileName(pluginName), pluginPath), gameRelease);
        var touched = new List<TouchedRecord>();
        // #459: SourceRecordPath.For now needs each record's position among its own group-folder
        // siblings. EnumerateMajorRecords walks the externally-changed binary's own deserialized
        // object graph, which preserves each group's real GRUP order — so a running per-group counter,
        // incremented in the same walk, reproduces exactly the index Track would assign this same
        // binary, with no separate scan.
        var orderIndexByGroup = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var record in deepParsed.EnumerateMajorRecords())
        {
            var recordType = SourceRecordType.Resolve(record, schemas);
            var groupFolder = RecordTypeDispatch.For(gameRelease).FolderNameFor(recordType);
            var containerFormKey = record.FormKey.ToString();

            // #460 (Keep half): a container/embedded record has no flat, directly-computable path, but
            // it may well already have a real file — the overwhelmingly common case, a container Track
            // or a prior edit already wrote to the tree. SourceUnitResolver is the same disk-scan
            // resolution RecordEditService's point-write path already uses successfully for this exact
            // record-shape class, reused here rather than re-derived.
            if (groupFolder is null)
            {
                var unit = SourceUnitResolver.Resolve(
                    reads, plugin, modFolder, containerFormKey, recordType, record.EditorID, gameRelease);

                if (unit is null)
                {
                    // Truly new: never tracked, nowhere in the tree, and the index names no container
                    // that would hold it either. Landing a brand-new container needs the layout grammar
                    // that places it, which this method does not have — logged and skipped, exactly
                    // like the old blanket container skip, but now only for the residual case that
                    // actually has no home to land in (tracked separately as a follow-up).
                    logger.LogDebug(
                        "Skipping {FormKey} ({RecordType}) in {Plugin}: no existing source unit anywhere in " +
                        "the tree — landing a brand-new container isn't supported yet",
                        record.FormKey, recordType, pluginName);
                    continue;
                }

                if (unit.Value.IsEmbedded)
                {
                    // This record has no file of its own — it is inlined in its owner's document
                    // (#450), and that owner is itself walked by this same EnumerateMajorRecords loop,
                    // so its own pass (below, non-embedded) already serializes this child's current
                    // value as part of the owner's whole text. Nothing to separately write here.
                    continue;
                }

                var ownIncomingText = Encoding.UTF8.GetString(
                    codec.SerializeToBytesAsync(record, gameRelease).GetAwaiter().GetResult());
                baselineByPath.TryGetValue(ToGitPath(unit.Value.RelativePath), out var ownBaselineText);
                if (string.Equals(ownIncomingText, ownBaselineText, StringComparison.Ordinal))
                    continue; // the external change never actually touched this record

                var ownCurrentText = File.Exists(unit.Value.FullPath) ? File.ReadAllText(unit.Value.FullPath) : null;
                touched.Add(new TouchedRecord(
                    containerFormKey, unit.Value.RelativePath, unit.Value.FullPath, unit.Value.FullPath,
                    ownIncomingText, ownCurrentText, ownBaselineText));
                continue;
            }

            var orderIndex = orderIndexByGroup.GetValueOrDefault(groupFolder);
            orderIndexByGroup[groupFolder] = orderIndex + 1;

            var formKey = record.FormKey.ToString();
            var relativePath = SourceRecordPath.For(pluginName, recordType, formKey, record.EditorID, gameRelease, orderIndex);
            var incomingText = Encoding.UTF8.GetString(codec.SerializeToBytesAsync(record, gameRelease).GetAwaiter().GetResult());

            baselineByPath.TryGetValue(ToGitPath(relativePath), out var baselineText);
            if (string.Equals(incomingText, baselineText, StringComparison.Ordinal))
                continue; // the external change never actually touched this record

            // #459 review finding: an external add/delete anywhere earlier in this group shifts every
            // later sibling's own order index, hence its own file name, even when that sibling's own
            // fields never changed — this record can therefore already have a real file sitting at its
            // *old* index. Resolved by FormKey suffix (index- and EditorID-blind, the same lookup
            // RecordEditService's own point writes use), not assumed to be wherever the freshly
            // computed name says, so the collision check below reads the record's actual current
            // working-tree text and landing can clean the stale old file up instead of leaving two
            // files claiming one FormKey behind (exactly the corruption AmbiguousSourceUnitException
            // exists to catch elsewhere).
            var existingPath = SourceUnitResolver.FlatSourcePath(
                modFolder, pluginName, recordType, formKey, record.EditorID, gameRelease);
            var fullPath = Path.Combine(modFolder, relativePath);
            var currentText = File.Exists(existingPath) ? File.ReadAllText(existingPath) : null;
            touched.Add(new TouchedRecord(formKey, relativePath, fullPath, existingPath, incomingText, currentText, baselineText));
        }

        var colliding = touched
            .Where(t => !string.Equals(t.CurrentText, t.BaselineText, StringComparison.Ordinal)
                     && !string.Equals(t.CurrentText, t.IncomingText, StringComparison.Ordinal))
            .ToList();
        if (colliding.Count > 0)
        {
            return ExternalChangeLandResult.Refused(
                $"{pluginName} has uncommitted working-tree changes on record(s) the external change also " +
                $"touched — {string.Join(", ", colliding.Select(c => c.FormKey))}. Commit or revert them, then " +
                "answer the external-change question again.");
        }

        foreach (var t in touched)
        {
            // The stale file at the old order index, if this record's index shifted — never left
            // behind as a duplicate (see this record's own construction, above).
            if (!string.Equals(t.ExistingPath, t.FullPath, StringComparison.Ordinal) && File.Exists(t.ExistingPath))
                File.Delete(t.ExistingPath);

            Directory.CreateDirectory(Path.GetDirectoryName(t.FullPath)!);
            File.WriteAllText(t.FullPath, t.IncomingText);
        }

        // The working tree (touched records' new dirt included) is now the state that corresponds to
        // this binary — atRef: null snapshots it as it stands, the same idiom Save & Compile parks
        // under (ParkCompileSnapshot's own doc comment).
        var binarySha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(pluginPath)));
        SourceRepository.ParkCompileSnapshot(modFolder, pluginName, atRef: null, binarySha256);
        ExternalChangeDeferral.Clear(modFolder, pluginName);

        return ExternalChangeLandResult.Success([.. touched.Select(t => t.FormKey)]);
    }

    private static string ToGitPath(string relativePath) => relativePath.Replace('\\', '/');

    private sealed record TouchedRecord(
        string FormKey, string RelativePath, string FullPath, string ExistingPath, string IncomingText,
        string? CurrentText, string? BaselineText);
}

/// <summary>Keep as My Edit's outcome — a typed refusal (naming the colliding records), never a
/// partial apply: either every touched record lands, or none of them do.</summary>
public sealed record ExternalChangeLandResult(bool Applied, string? RefusalReason, IReadOnlyList<string> LandedFormKeys)
{
    public static ExternalChangeLandResult Success(IReadOnlyList<string> landedFormKeys) => new(true, null, landedFormKeys);

    public static ExternalChangeLandResult Refused(string reason) => new(false, reason, []);
}
