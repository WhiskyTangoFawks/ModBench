using System.Text;
using System.Text.Json;
using MEditService.Core.Ledger;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using MEditService.Core.Session;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Edits;

/// <summary>
/// The single write path (ADR-0041 / #415): a field edit on a tracked plugin becomes a working-tree
/// change to that record's ledger JSON, and nothing else. There is no second path — no direct binary
/// write, no staged pending state — which is why an untracked plugin is refused here rather than
/// quietly served by some other mechanism.
///
/// <para><b>The ledger text is the source, not the index.</b> Each edit reads the record's ledger
/// file, applies the field to the record that text deserializes to, and writes the file back; the
/// index is then told what landed. Reading the file rather than the indexed body is deliberate and
/// measured: ingest serializes from a plugin's <i>binary overlay</i> while the ledger holds a
/// <i>deep parse</i>, and the two are not always structurally identical (#369's 1-in-3,940 hole,
/// documented on <see cref="GitBlobHash"/>). Editing the file's own bytes means an edit can never
/// silently rewrite a record's unrelated fields into the overlay's shape.</para>
///
/// <para>Every refusal happens <b>before</b> anything is written, so a refused edit leaves the
/// working tree exactly as it was — there is no half-applied state for the user to discover in the
/// Source Control panel.</para>
/// </summary>
public sealed class RecordEditService(
    ISessionManager sessions,
    ISchemaReflector schemaReflector,
    ILogger<RecordEditService> logger)
{
    private readonly RecordTextCodec _codec = new(Microsoft.Extensions.Logging.Abstractions.NullLogger<RecordTextCodec>.Instance);

    /// <summary>
    /// Applies <paramref name="value"/> to <paramref name="fieldPath"/> on one plugin's copy of
    /// <paramref name="formKey"/>. Complex fields arrive as one whole value (CONTEXT.md's atomic
    /// field-level write), VMAD and condition paths included — see <see cref="RecordFieldWriter"/>
    /// for the dispatch.
    /// </summary>
    public RecordEditResult EditField(PluginKey plugin, string formKey, string fieldPath, JsonElement value)
    {
        if (ResolveWritableModFolder(plugin) is not { } modFolder)
            return RefuseUntracked(plugin);

        var index = sessions.Index;
        if (index == null)
            return RecordEditResult.Refused(RecordEditRefusal.RecordNotFound, "No session is loaded.");

        // The effective document, because that is what the user is looking at and editing from — a
        // second edit to the same record must build on the first, not on the committed baseline.
        var document = index.GetDocument(formKey, plugin);
        if (document == null)
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.RecordNotFound,
                $"{plugin.Name} does not hold record {formKey}.");
        }

        var release = sessions.Session!.GameRelease;
        var relativePath = LedgerRecordPath.For(plugin.Name, document.RecordType, formKey);
        var ledgerPath = Path.Combine(modFolder, relativePath);

        var record = ReadRecordFromLedger(ledgerPath, document, release);
        var schemas = schemaReflector.GetSchemas(release);

        var outcome = RecordFieldWriter.TryApply(record, document.RecordType, fieldPath, value, schemas, release);
        if (outcome != FieldApplyOutcome.Applied)
            return RefuseFieldOutcome(outcome, fieldPath, document.RecordType);

        var newBody = _codec.SerializeToBytesAsync(record, release).GetAwaiter().GetResult();

        // #412: the codec's own file write is atomic (temp file, then rename), which matters more
        // here than at Track — this file is inside a live git working tree that the SCM panel, and
        // git itself, may read at any moment.
        _codec.SerializeAsync(record, ledgerPath, release).GetAwaiter().GetResult();

        index.ApplyWorkingTreeChanges(plugin, [(formKey, Encoding.UTF8.GetString(newBody))]);

        logger.LogInformation(
            "Edited {FieldPath} on {FormKey} in {Plugin} ({Origin}) — working-tree change written to {LedgerPath}",
            fieldPath, formKey, plugin.Name, plugin.Origin, relativePath);
        return RecordEditResult.Success();
    }

    /// <summary>
    /// The mod folder this plugin's ledger lives in, or null when the plugin cannot be edited at
    /// all. Tracked *is* the presence of <c>.git</c> (ADR-0041) — no registry, and the answer is
    /// re-asked on every edit rather than cached, because the folder can be destroyed or created
    /// outside Modbench between one edit and the next.
    /// </summary>
    private string? ResolveWritableModFolder(PluginKey plugin)
    {
        if (ModFolderOf(plugin) is not { } modFolder) return null;
        return LedgerRepository.IsTracked(modFolder) ? modFolder : null;
    }

    private string? ModFolderOf(PluginKey plugin)
    {
        // A plugin resolved from the game's Data directory has no mod folder in the sense Track
        // means: its containing folder is the game's own, which is never a repo. That is a different
        // refusal with a different way out, so it is distinguished here rather than folded into
        // "not tracked" — see RefuseUntracked.
        if (string.Equals(plugin.Origin, PluginOrigin.DataDirectory, StringComparison.OrdinalIgnoreCase))
            return null;

        var metadata = sessions.Session?.Plugins.FirstOrDefault(p =>
            p.Name.Equals(plugin.Name, StringComparison.OrdinalIgnoreCase)
            && p.Origin.Equals(plugin.Origin, StringComparison.OrdinalIgnoreCase));

        return metadata?.Path is { } path ? Path.GetDirectoryName(path) : null;
    }

    // AC4: two refusals, because there are two different ways out and a message that named neither
    // would be the "silent dead UI" this ticket exists to avoid.
    private RecordEditResult RefuseUntracked(PluginKey plugin) =>
        ModFolderOf(plugin) is null
            ? RecordEditResult.Refused(
                RecordEditRefusal.PluginHasNoModFolder,
                $"{plugin.Name} is a base-game plugin with no mod folder, so it cannot be tracked. " +
                "Author a patch plugin and edit the override there.")
            : RecordEditResult.Refused(
                RecordEditRefusal.PluginNotTracked,
                $"{plugin.Name} is not tracked, so it is read-only. " +
                "Run \"Modbench: Track Mod\" on it once to start editing.");

    private static RecordEditResult RefuseFieldOutcome(FieldApplyOutcome outcome, string fieldPath, string recordType) =>
        outcome == FieldApplyOutcome.ReadOnly
            ? RecordEditResult.Refused(RecordEditRefusal.FieldReadOnly, $"'{fieldPath}' is read-only.")
            : RecordEditResult.Refused(RecordEditRefusal.FieldNotFound, $"'{recordType}' has no field '{fieldPath}'.");

    /// <summary>
    /// The record as its ledger text has it. Falls back to the indexed body only when the file is
    /// missing entirely — never-assume-exclusive-ownership (root CLAUDE.md): a tracked mod's ledger
    /// tree is complete when Track leaves it, but anything may have removed a file since, and
    /// refusing the edit would strand the user with no way to put the record back.
    /// </summary>
    private IMajorRecord ReadRecordFromLedger(string ledgerPath, RecordDocument document, GameRelease release)
    {
        if (File.Exists(ledgerPath))
            return _codec.DeserializeAsync(ledgerPath, release).GetAwaiter().GetResult();

        logger.LogWarning(
            "Ledger file {LedgerPath} is missing; editing from the indexed document and rewriting it", ledgerPath);
        return _codec
            .DeserializeFromBytesAsync(Encoding.UTF8.GetBytes(document.Body!), release)
            .GetAwaiter().GetResult();
    }
}
