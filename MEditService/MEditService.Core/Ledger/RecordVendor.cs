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
/// Copy-on-write vendoring (ADR-0040): the first staged edit to a record in an untracked origin
/// creates that origin's ledger repo, commits the record's pristine text (serialized from a fresh
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
    /// Serialized per <paramref name="originFolder"/> — see <see cref="LedgerOriginGate"/>, shared
    /// with <c>LedgerGroupCommitter</c>'s save-time commit (#371) since both stage into the same
    /// gitdir/index.
    /// </summary>
    public async Task VendorAndStageDirtAsync(
        string originFolder,
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
        var gate = LedgerOriginGate.GateFor(originFolder);
        await gate.WaitAsync(cancel).ConfigureAwait(false);
        try
        {
            ledger.EnsureRepo(originFolder);
            var relativePath = LedgerRecordPath.For(pluginFileName, recordType, formKeyString);
            var absolutePath = Path.Combine(originFolder, relativePath);

            if (ledger.IsTrackedAtHead(originFolder, relativePath))
            {
                var record = await codec.DeserializeAsync(absolutePath, concreteRecordType, release, cancel).ConfigureAwait(false);
                ApplyFields(record, fields, recordType, schemas, release);
                await codec.SerializeAsync((IMajorRecordGetter)record, absolutePath, release, cancel).ConfigureAwait(false);
            }
            else
            {
                await VendorPristineThenDirtAsync(
                    originFolder, pluginFilePath, formKeyString, recordType, relativePath, absolutePath,
                    fields, schemas, release, cancel).ConfigureAwait(false);
            }

            logger.LogTrace("Staged dirt for {FormKey} at {Path}", formKeyString, absolutePath);
        }
        finally
        {
            gate.Release();
        }
    }

    // First touch. Order is load-bearing (#370 review finding 3): reset the index to a known-clean
    // state (#371 review finding — see LedgerRepository.ResetIndexToHead's own remarks: without
    // this, a stray entry an earlier, unrelated failed attempt against this same origin folder left
    // behind would get folded into *this* commit), then write + stage the pristine text, then do
    // everything that can still fail (apply the staged fields, write dirt), and only commit — the
    // operation that makes the record permanently tracked (IsTrackedAtHead gates the deep-parse
    // branch on "not yet tracked", so a tracked-but-half-vendored record would never be retried) —
    // once all of that has succeeded. This works with plain `git add` + `git commit` rather than
    // needing plumbing: `git commit` always commits the *index* state, never the working-tree
    // file's content at commit time, so staging the pristine blob here and overwriting the
    // working-tree file with dirt afterward still leaves the commit holding pristine — see
    // LedgerRepository's own remarks. A failure anywhere below leaves no commit at all: at worst an
    // inert staged-but-uncommitted index entry, cleaned up by the *next* attempt's own
    // ResetIndexToHead rather than merely superseded by luck.
    private async Task VendorPristineThenDirtAsync(
        string originFolder, string pluginFilePath, string formKeyString, string recordType,
        string relativePath, string absolutePath,
        IReadOnlyDictionary<string, JsonElement> fields, IReadOnlyDictionary<string, RecordTableSchema> schemas,
        GameRelease release, CancellationToken cancel)
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
        // single-use deep-parsed object; see ContainerStripFields' own remarks for why that's safe
        // without a defensive copy.
        ContainerStripFields.StripInPlace(pristine);

        ledger.ResetIndexToHead(originFolder);

        Directory.CreateDirectory(Path.GetDirectoryName(absolutePath)!);
        await codec.SerializeAsync((IMajorRecordGetter)pristine, absolutePath, release, cancel).ConfigureAwait(false);
        ledger.StagePath(originFolder, relativePath);

        // Everything from here down can still fail — deliberately staged (above) but not yet
        // committed. On failure, unstage rather than leave the pristine blob sitting in the index:
        // CommitStaged commits the index as a whole (see its own remarks on why it takes no
        // pathspec), so an un-cleared stray entry here would otherwise get swept into some later,
        // unrelated successful commit in this same origin folder.
        try
        {
            ApplyFields(pristine, fields, recordType, schemas, release);
            await codec.SerializeAsync((IMajorRecordGetter)pristine, absolutePath, release, cancel).ConfigureAwait(false);
        }
        catch
        {
            ledger.UnstagePath(originFolder, relativePath);
            throw;
        }

        ledger.CommitStaged(originFolder, $"vendor: {recordType} {formKeyString}");
    }

    // Reuses PluginWriter's own per-field apply path (TryApplyField, widened private -> internal
    // for #370) rather than re-implementing field application: it already dispatches VMAD/condition
    // fields correctly, which an ordinary PATCH /records edit can carry even outside the dedicated
    // VMAD-struct-op endpoint. A synthetic PendingChange carries only what TryApplyField actually
    // reads (ChangeType/FieldPath/NewValue/RecordType); the rest of the record's many fields
    // (Id/ChangedAt/Resolutions/...) are inert here and filled with the closest-to-neutral value.
    //
    // Two things #370's review found missing here, both fixed:
    // - TryApplyField's ApplyOutcome was discarded; a ReadOnly/NotFound field silently never reached
    //   the vendored dirt. Now a non-Applied outcome throws (finding 2) — surfaced through the same
    //   best-effort catch in EditOrchestrator.VendorOnFirstTouch as every other vendoring failure,
    //   rather than landing invisibly.
    // - The batch had no equivalent to PluginWriter.ApplyFieldChanges' condition-list-restage
    //   ordering (finding 6): reused directly (PluginWriter.OrderForConditionListRestage, also
    //   widened internal) rather than reimplemented, so a batched PATCH mixing a whole-list restage
    //   with a nested per-index edit vendors the same result the eventual real save would produce.
    //
    // internal, not private (#373): LedgerGroupCommitter's own $create write reuses this exact
    // batch-apply path to apply a pending create's staged field_edit rows onto the freshly
    // instantiated blank record — the same "no re-implementation, no drift from what a real save
    // would produce" reasoning above, applied to the one write shape this method didn't originally
    // need to cover (there was no live record to deep-parse before the create itself lands).
    internal static void ApplyFields(
        IMajorRecord record,
        IReadOnlyDictionary<string, JsonElement> fields,
        string recordType,
        IReadOnlyDictionary<string, RecordTableSchema> schemas,
        GameRelease release)
    {
        var changes = fields.Select(kv => new PendingChange(
            Id: Guid.NewGuid(),
            FormKey: record.FormKey.ToString(),
            Plugin: record.FormKey.ModKey.FileName.String,
            FieldPath: kv.Key,
            RecordType: recordType,
            OldValue: PendingChangeConstants.NullElement,
            NewValue: kv.Value,
            Source: "vendor",
            Description: null,
            ChangedAt: DateTime.UtcNow,
            ChangeType: PendingChangeConstants.FieldEditChangeType,
            ParentCell: null,
            PlacementGroup: null,
            Resolutions: null,
            RecordResolution: null,
            RecordTypeDisplayName: null,
            Origin: "vendor"))
            .ToList();

        foreach (var change in PluginWriter.OrderForConditionListRestage(changes))
        {
            var outcome = PluginWriter.TryApplyField(record, change, schemas, release);
            if (outcome != PluginWriter.ApplyOutcome.Applied)
                throw new VendorFieldApplyException(change.FieldPath, outcome.ToString());
        }
    }
}

/// <summary>
/// Thrown by <see cref="RecordVendor"/> when a staged field fails to apply while vendoring
/// (<see cref="PluginWriter.TryApplyField"/> returned something other than
/// <see cref="PluginWriter.ApplyOutcome.Applied"/>) — surfaced rather than silently dropped, so the
/// ledger's dirt never diverges from the pending-change DB's own record of what was staged without
/// anything saying so (#370 review finding 2).
/// </summary>
public sealed class VendorFieldApplyException : Exception
{
    public VendorFieldApplyException()
    {
    }

    public VendorFieldApplyException(string message) : base(message)
    {
    }

    public VendorFieldApplyException(string message, Exception innerException) : base(message, innerException)
    {
    }

    internal VendorFieldApplyException(string fieldPath, string outcome)
        : base($"Vendoring could not apply field '{fieldPath}' ({outcome}) — nothing was written or " +
               "committed for it, so the ledger does not silently diverge from what was actually staged.")
    {
    }
}
