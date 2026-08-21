using MEditService.Core.Records;
using MEditService.Core.Serialization;
using Mutagen.Bethesda;

namespace MEditService.Core.Source;

/// <summary>
/// #427 Epic B′: rediscovers a working-tree-only create at session load. <see cref="IRecordIndex.Index"/>
/// ingests a plugin's binary and knows nothing else — a record <see cref="Edits.RecordEditService.CreateRecord"/>
/// wrote but nobody has compiled yet has no binary row to seed from, so without this sweep it answers
/// at Effective only during the session that created it and then silently vanishes from the read
/// model on the next restart — while compile (<c>PluginCompileService</c>, which assembles straight
/// from source files on disk) still emits it into the binary. What the user sees and what gets built
/// diverge: a correctness hole, not a cosmetic one. Root CLAUDE.md's never-assume-exclusive-ownership
/// rule is exactly on point — an added source file is precisely the disk-state class every mechanism
/// that tracks state derived from disk must recover from, the same posture <see cref="SourceFreshness"/>
/// already takes for a <i>changed</i> one.
///
/// <para><b>Deliberately not filtered by git's own status letter.</b> #427's write path never runs
/// <c>git add</c>, so a freshly created record's source file is untracked (<c>??</c>), not staged
/// (<c>A</c>) — a filter looking only for a staged add would miss the overwhelmingly common case.
/// Every dirty path under this plugin's source tree is instead asked the same question ordinary
/// ingest already answered for every other record: does either ref know this FormKey yet. A "no" is
/// exactly a working-tree-only create; anything else (a modified or working-tree-deleted existing
/// record, which <see cref="Index"/> already gave a row) is <see cref="SourceFreshness"/>'s read-time
/// job, not this sweep's — this only ever calls <see cref="IRecordIndex.CreateWorkingTreeRecord"/>,
/// which itself refuses (throws) if either ref already knows the FormKey, so the two mechanisms can
/// never collide over the same record.</para>
///
/// <para><b>Related, narrower gap this does not close</b> (flagged, not built): a mid-session <c>git
/// checkout</c> that adds a source file after this sweep already ran is likewise invisible to
/// <see cref="SourceFreshness"/>, which only re-validates a FormKey the index already has a row for —
/// it has no way to learn about a FormKey it has never heard of without a caller asking for it by
/// name. Only a second sweep (session load, or a future live one) would catch that.</para>
/// </summary>
public static class WorkingTreeCreateRediscovery
{
    /// <summary>Sweeps one just-indexed plugin's tracked mod folder. Safe to call for an untracked
    /// folder's caller (the caller gates on <see cref="SourceRepository.IsTracked"/> already) and
    /// does nothing when there is no dirt at all — the common case, and the reason this costs nothing
    /// for an unedited session, the same bound <see cref="SourceFreshness"/> holds itself to.
    ///
    /// <para><b>#451 slice E note, not a permanent design:</b> #452 deletes this whole class ("Delete
    /// the reconciliation-sweep class... and the delete-at-load correction path"). The FormKey used to
    /// come straight from <see cref="SourceRecordPath.TryParse"/>'s own path parse, with no file read,
    /// for every dirty path already known to either ref; under the Spriggit flat layout a path alone
    /// no longer carries a recoverable FormKey (<see cref="SourceRecordIdentity"/>'s own doc comment),
    /// so this now reads+deserializes every dirty flat path to learn it, losing that short-circuit.
    /// That cost is bounded by dirt, not load order (this method's own doc comment already priced
    /// that shape) — the minimum change that keeps this correct until #452 removes it outright, not a
    /// restoration of the old short-circuit by another route.</para>
    /// </summary>
    public static void Sweep(IRecordIndex index, string modFolder, PluginKey plugin, GameRelease gameRelease)
    {
        var codec = new RecordTextCodec(Microsoft.Extensions.Logging.Abstractions.NullLogger<RecordTextCodec>.Instance);
        foreach (var relativePath in SourceRepository.WorkingTreeStatus(modFolder))
        {
            if (!SourceRecordPath.TryParse(relativePath, gameRelease, out var identity)) continue;
            if (!identity.PluginFileName.Equals(plugin.Name, StringComparison.OrdinalIgnoreCase)) continue;

            // A working-tree deletion of a record that was never committed leaves a git status entry
            // with no file behind it — nothing to rediscover there, since it already answers gone at
            // both refs without this sweep's help.
            var fullPath = Path.Combine(modFolder, relativePath);
            if (!File.Exists(fullPath)) continue;

            var body = File.ReadAllText(fullPath);
            var record = codec.DeserializeAsync(fullPath, gameRelease, identity.RecordType).GetAwaiter().GetResult();
            var formKey = record.FormKey.ToString();

            if (index.GetDocument(formKey, plugin) != null) continue;
            if (index.At(RecordRef.Head).GetDocument(formKey, plugin) != null) continue;

            index.CreateWorkingTreeRecord(plugin, formKey, identity.RecordType, body);
        }
    }
}
