using System.Security.Cryptography;
using System.Text;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Ledger;

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
    public static ExternalChangeLandResult Keep(string modFolder, string pluginName, string pluginPath, GameRelease gameRelease, ISchemaReflector reflector)
    {
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var schemas = reflector.GetSchemas(gameRelease);

        var parkedRef = $"refs/medit/last-compile/{pluginName}";
        var baselineByPath = LedgerRepository.EnumerateLedgerAtRef(modFolder, pluginName, parkedRef)
            .ToDictionary(f => ToGitPath(f.RelativePath), f => Encoding.UTF8.GetString(f.Bytes), StringComparer.Ordinal);

        var deepParsed = ModFactory.ImportSetter(new ModPath(ModKey.FromFileName(pluginName), pluginPath), gameRelease);
        var touched = new List<TouchedRecord>();
        foreach (var record in deepParsed.EnumerateMajorRecords())
        {
            ContainerStripFields.StripInPlace(record);
            var recordType = LedgerRecordType.Resolve(record, schemas);
            var formKey = record.FormKey.ToString();
            var relativePath = LedgerRecordPath.For(pluginName, recordType, formKey);
            var incomingText = Encoding.UTF8.GetString(codec.SerializeToBytesAsync(record, gameRelease).GetAwaiter().GetResult());

            baselineByPath.TryGetValue(ToGitPath(relativePath), out var baselineText);
            if (string.Equals(incomingText, baselineText, StringComparison.Ordinal))
                continue; // the external change never actually touched this record

            var fullPath = Path.Combine(modFolder, relativePath);
            var currentText = File.Exists(fullPath) ? File.ReadAllText(fullPath) : null;
            touched.Add(new TouchedRecord(formKey, relativePath, fullPath, incomingText, currentText, baselineText));
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
            Directory.CreateDirectory(Path.GetDirectoryName(t.FullPath)!);
            File.WriteAllText(t.FullPath, t.IncomingText);
        }

        // The working tree (touched records' new dirt included) is now the state that corresponds to
        // this binary — atRef: null snapshots it as it stands, the same idiom Save & Compile parks
        // under (ParkCompileSnapshot's own doc comment).
        var binarySha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(pluginPath)));
        LedgerRepository.ParkCompileSnapshot(modFolder, pluginName, atRef: null, binarySha256);
        ExternalChangeDeferral.Clear(modFolder, pluginName);

        return ExternalChangeLandResult.Success([.. touched.Select(t => t.FormKey)]);
    }

    private static string ToGitPath(string relativePath) => relativePath.Replace('\\', '/');

    private sealed record TouchedRecord(
        string FormKey, string RelativePath, string FullPath, string IncomingText, string? CurrentText, string? BaselineText);
}

/// <summary>Keep as My Edit's outcome — a typed refusal (naming the colliding records), never a
/// partial apply: either every touched record lands, or none of them do.</summary>
public sealed record ExternalChangeLandResult(bool Applied, string? RefusalReason, IReadOnlyList<string> LandedFormKeys)
{
    public static ExternalChangeLandResult Success(IReadOnlyList<string> landedFormKeys) => new(true, null, landedFormKeys);

    public static ExternalChangeLandResult Refused(string reason) => new(false, reason, []);
}
