using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Ledger;

/// <summary>
/// Copy-on-write vendoring (ADR-0040): the first staged edit to a record in an untracked mod
/// creates that mod's ledger repo, commits the record's pristine text (serialized from a fresh
/// <b>deep parse</b> of the plugin binary — never the session's lazy overlay; see the class remarks
/// below) as the baseline, and writes the edited text as uncommitted working-tree dirt. A record
/// already tracked at <c>HEAD</c> skips the deep parse entirely — its current ledger text (pristine
/// or prior dirt) is read back and re-edited, so only first touch ever costs a binary read.
///
/// <b>Deep parse, not the overlay, is not a latency choice — it is a correctness one.</b> The
/// session's own read path (<c>GameSession</c>/<c>DefaultModImporter</c>) uses
/// <c>ModFactory.ImportGetter</c> (Mutagen's lazy binary overlay) for indexing, and that stays
/// untouched — this class does not read through the session at all. What gets vendored here becomes
/// the baseline every later diff is measured against, so an overlay mis-parse (#369) would be baked
/// into committed truth permanently, with no later correct parse able to fix it without reading as a
/// spurious user edit.
/// </summary>
public sealed class RecordVendor(LedgerRepository ledger, RecordTextCodec codec, ILogger<RecordVendor> logger)
{
    /// <summary>
    /// Vendors <paramref name="formKeyString"/> if it is not already tracked, then writes
    /// <paramref name="fields"/> applied on top as uncommitted working-tree dirt. No-op-safe to call
    /// repeatedly: a second call for an already-tracked record adds no new baseline commit (AC3).
    /// </summary>
    public async Task VendorAndStageDirtAsync(
        string modFolderAbsolutePath,
        string pluginFilePath,
        string pluginFileName,
        string recordType,
        Type concreteRecordType,
        string formKeyString,
        IReadOnlyDictionary<string, JsonElement> fields,
        IReadOnlyDictionary<string, RecordTableSchema> schemas,
        GameRelease release,
        CancellationToken cancel = default)
    {
        ledger.EnsureRepo(modFolderAbsolutePath);
        var relativePath = LedgerRecordPath.For(pluginFileName, recordType, formKeyString);
        var absolutePath = Path.Combine(modFolderAbsolutePath, relativePath);

        var record = ledger.IsTrackedAtHead(modFolderAbsolutePath, relativePath)
            ? await codec.DeserializeAsync(absolutePath, concreteRecordType, release, cancel)
            : await VendorPristineAsync(modFolderAbsolutePath, pluginFilePath, formKeyString, recordType, relativePath, absolutePath, release, cancel);

        ApplyFields(record, fields, recordType, schemas, release);

        await codec.SerializeAsync((IMajorRecordGetter)record, absolutePath, release, cancel);
        logger.LogTrace("Staged dirt for {FormKey} at {Path}", formKeyString, absolutePath);
    }

    private async Task<IMajorRecord> VendorPristineAsync(
        string modFolderAbsolutePath, string pluginFilePath, string formKeyString, string recordType,
        string relativePath, string absolutePath, GameRelease release, CancellationToken cancel)
    {
        if (!FormKey.TryFactory(formKeyString, out var formKey))
            throw new ArgumentException($"'{formKeyString}' is not a valid FormKey.", nameof(formKeyString));

        // Deep parse — see the class remarks. ModFactory.ImportSetter resolves to a genuine binary
        // deep parse (confirmed: BinaryRoundTripGateTests), never the overlay, regardless of what
        // the session already has open.
        var modKey = ModKey.FromFileName(Path.GetFileName(pluginFilePath));
        var deepParsed = ModFactory.ImportSetter(new ModPath(modKey, pluginFilePath), release);
        var pristine = deepParsed.EnumerateMajorRecords().OfType<IMajorRecord>().FirstOrDefault(r => r.FormKey == formKey)
            ?? throw new InvalidOperationException($"Record '{formKeyString}' not found in '{pluginFilePath}' while vendoring.");

        // Container-shaped records vendor shallow (ADR-0040/#387 amendment) — in place, on this
        // single-use deep-parsed object, before its first (and only, from this read) serialize; see
        // ContainerStripFields' own remarks for why this is safe without a defensive copy.
        ContainerStripFields.StripInPlace(pristine);

        Directory.CreateDirectory(Path.GetDirectoryName(absolutePath)!);
        await codec.SerializeAsync((IMajorRecordGetter)pristine, absolutePath, release, cancel);
        ledger.CommitPristine(modFolderAbsolutePath, relativePath, $"vendor: {recordType} {formKeyString}");

        return pristine;
    }

    // Reuses PluginWriter's own per-field apply path (TryApplyField, widened private -> internal
    // for #370) rather than re-implementing field application: it already dispatches VMAD/condition
    // fields correctly, which an ordinary PATCH /records edit can carry even outside the dedicated
    // VMAD-struct-op endpoint. A synthetic PendingChange carries only what TryApplyField actually
    // reads (ChangeType/FieldPath/NewValue/RecordType); the rest of the record's many fields
    // (Id/ChangedAt/Resolutions/...) are inert here and filled with the closest-to-neutral value.
    private static void ApplyFields(
        IMajorRecord record,
        IReadOnlyDictionary<string, JsonElement> fields,
        string recordType,
        IReadOnlyDictionary<string, RecordTableSchema> schemas,
        GameRelease release)
    {
        foreach (var (fieldPath, newValue) in fields)
        {
            var change = new PendingChange(
                Id: Guid.NewGuid(),
                FormKey: record.FormKey.ToString(),
                Plugin: record.FormKey.ModKey.FileName.String,
                FieldPath: fieldPath,
                RecordType: recordType,
                OldValue: PendingChangeConstants.NullElement,
                NewValue: newValue,
                Source: "vendor",
                Description: null,
                ChangedAt: DateTime.UtcNow,
                ChangeType: PendingChangeConstants.FieldEditChangeType,
                ParentCell: null,
                PlacementGroup: null,
                Resolutions: null,
                RecordResolution: null,
                RecordTypeDisplayName: null,
                Origin: "vendor");

            PluginWriter.TryApplyField(record, change, schemas, release);
        }
    }
}
