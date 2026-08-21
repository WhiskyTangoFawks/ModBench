using System.Globalization;
using System.Text;
using System.Text.Json;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using MEditService.Core.Session;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Plugins.Utility;

namespace MEditService.Core.Edits;

/// <summary>
/// The single write path (ADR-0041 / #415): a field edit on a tracked plugin becomes a working-tree
/// change to that record's source JSON, and nothing else. There is no second path — no direct binary
/// write, no staged pending state — which is why an untracked plugin is refused here rather than
/// quietly served by some other mechanism.
///
/// <para><b>The source text is the source, not the index.</b> Each edit reads the record's source
/// file, applies the field to the record that text deserializes to, and writes the file back; the
/// index is then told what landed. Reading the file rather than the indexed body is deliberate and
/// measured: ingest serializes from a plugin's <i>binary overlay</i> while the source holds a
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
        if (RefuseIfBlocked(plugin, out var modFolder) is { } blocked) return blocked;

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
        var relativePath = SourceRecordPath.For(plugin.Name, document.RecordType, formKey);
        var sourcePath = Path.Combine(modFolder, relativePath);

        var record = ReadRecordFromSource(sourcePath, document, release);
        var schemas = schemaReflector.GetSchemas(release);

        if (ValidateFormLinks(index, schemas, document.RecordType, fieldPath, value) is { } linkError)
            return RecordEditResult.Refused(RecordEditRefusal.InvalidFormLink, linkError);

        var outcome = RecordFieldWriter.TryApply(record, document.RecordType, fieldPath, value, schemas, release);
        if (outcome != FieldApplyOutcome.Applied)
            return RefuseFieldOutcome(outcome, fieldPath, document.RecordType);

        var newBody = _codec.SerializeToBytesAsync(record, release).GetAwaiter().GetResult();

        // #412: the codec's own file write is atomic (temp file, then rename), which matters more
        // here than at Track — this file is inside a live git working tree that the SCM panel, and
        // git itself, may read at any moment.
        _codec.SerializeAsync(record, sourcePath, release).GetAwaiter().GetResult();

        index.ApplyWorkingTreeChanges(plugin, [(formKey, Encoding.UTF8.GetString(newBody))]);
        // #422: the new value can flip filter membership either way.
        sessions.ReapplyFilter();

        logger.LogInformation(
            "Edited {FieldPath} on {FormKey} in {Plugin} ({Origin}) — working-tree change written to {SourcePath}",
            fieldPath, formKey, plugin.Name, plugin.Origin, relativePath);
        return RecordEditResult.Success();
    }

    /// <summary>
    /// #427: deletes one plugin's copy of <paramref name="formKey"/> as a working-tree change — the
    /// source file goes away, and <see cref="IRecordIndex.ApplyWorkingTreeChanges"/>'s null-Body case
    /// (the mechanism #415 landed and tested in both flip directions) takes it from there: gone at
    /// Effective, still served at Head until this is committed and compiled. No reference cascade —
    /// a FormLink elsewhere pointing at the deleted record goes dangling and surfaces as an ordinary
    /// compile diagnostic, exactly like any other dangling link (ADR-0020).
    /// </summary>
    public RecordEditResult DeleteRecord(PluginKey plugin, string formKey)
    {
        if (RefuseIfBlocked(plugin, out var modFolder) is { } blocked) return blocked;

        var index = sessions.Index;
        if (index == null)
            return RecordEditResult.Refused(RecordEditRefusal.RecordNotFound, "No session is loaded.");

        var document = index.GetDocument(formKey, plugin);
        if (document == null)
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.RecordNotFound,
                $"{plugin.Name} does not hold record {formKey}.");
        }

        var relativePath = SourceRecordPath.For(plugin.Name, document.RecordType, formKey);
        var sourcePath = Path.Combine(modFolder, relativePath);

        // Never-assume-exclusive-ownership: the file may already be gone (another tool, a hand
        // delete) — that is exactly the working-tree state this call is trying to reach, not a
        // failure to report.
        if (File.Exists(sourcePath)) File.Delete(sourcePath);

        index.ApplyWorkingTreeChanges(plugin, [(formKey, null)]);

        logger.LogInformation(
            "Deleted {FormKey} from {Plugin} ({Origin}) — working-tree deletion of {SourcePath}",
            formKey, plugin.Name, plugin.Origin, relativePath);
        return RecordEditResult.Success();
    }

    /// <summary>
    /// #427: mints a brand-new record — the create half of a lifecycle gesture. The FormKey is either
    /// <paramref name="requestedFormKey"/> (xEdit's typed-FormID path) or, when null, the next free
    /// local FormID under the plugin's own ModKey, collision-checked against both
    /// <see cref="RecordRef.Effective"/> and <see cref="RecordRef.Head"/> so an uncompiled prior
    /// create or a working-tree-deleted record can never be handed out twice.
    /// </summary>
    public RecordEditResult CreateRecord(PluginKey plugin, string recordType, string? editorId, string? requestedFormKey = null)
    {
        if (RefuseIfBlocked(plugin, out var modFolder) is { } blocked) return blocked;

        var index = sessions.Index;
        if (index == null)
            return RecordEditResult.Refused(RecordEditRefusal.RecordNotFound, "No session is loaded.");

        var release = sessions.Session!.GameRelease;
        var schemas = schemaReflector.GetSchemas(release);
        if (recordType == HeaderIndexer.TableName || !schemas.TryGetValue(recordType, out var schema))
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.RecordTypeNotFound, $"'{recordType}' is not a creatable record type.");
        }

        if (ResolveTargetFormKey(index, plugin, requestedFormKey, out var targetFormKey) is { } refusedTarget) return refusedTarget;

        // Mutagen's own generic-across-games factory (Mutagen.Bethesda.Plugins.Utility) — every
        // generated major-record type's (FormKey, GameRelease) constructor is declared private
        // precisely so this is the supported way to reach it, rather than a hand-rolled reflection
        // bypass over Mutagen's own generated code.
        var record = MajorRecordInstantiator.Activator(FormKey.Factory(targetFormKey), release, schema.RecordType);
        if (!string.IsNullOrWhiteSpace(editorId)) record.EditorID = editorId;

        var relativePath = SourceRecordPath.For(plugin.Name, recordType, targetFormKey);
        var sourcePath = Path.Combine(modFolder, relativePath);

        // Track's eager serialization only created directories for (record type, origin ModKey)
        // combinations the plugin already held — a genuinely new one (the first Weapon a plugin ever
        // held, say) needs its own. The codec deliberately leaves directory-creation policy to its
        // caller (RecordTextCodec.SerializeAsync's own doc comment).
        Directory.CreateDirectory(Path.GetDirectoryName(sourcePath)!);

        var newBody = _codec.SerializeToBytesAsync(record, release).GetAwaiter().GetResult();
        _codec.SerializeAsync(record, sourcePath, release).GetAwaiter().GetResult();

        index.CreateWorkingTreeRecord(plugin, targetFormKey, recordType, Encoding.UTF8.GetString(newBody));
        // #422: a brand-new row can newly match an active filter.
        sessions.ReapplyFilter();

        logger.LogInformation(
            "Created {RecordType} {FormKey} in {Plugin} ({Origin}) — new working-tree source file at {SourcePath}",
            recordType, targetFormKey, plugin.Name, plugin.Origin, relativePath);
        return RecordEditResult.Success(targetFormKey);
    }

    /// <summary>
    /// #427: a renumber is a delete+create pair in source terms (the source path embeds the FormKey)
    /// plus a reference cascade — every other tracked plugin's FormLink to <paramref name="formKey"/>
    /// has to move with it, or it goes dangling the moment the old path disappears.
    ///
    /// <para><b>Native records only.</b> An override's FormKey belongs to the plugin that originated
    /// it, not to <paramref name="plugin"/> — renumbering it would mean renumbering the record across
    /// every plugin that overrides it, which is xEdit's own override-cascade and a materially bigger
    /// operation than this gesture does. Refused, naming the originating plugin.</para>
    ///
    /// <para><b>Untracked referencer refuses the whole renumber, before any write</b> — a FormLink
    /// rewrite is a working-tree change in that plugin's own repo, and an untracked one has no
    /// working tree to write to (the same posture as every other untracked refusal here).</para>
    ///
    /// <para><b>Write order is deliberate</b>: every referencing repo first, this record's own
    /// delete+create pair last. A mid-cascade failure then leaves the old FormKey still live at
    /// Effective — the blast radius is only the referencer repos already written, each independently
    /// revertable in the Source Control panel, and the target repo (whose own rewrite is the final,
    /// single-repo step) never enters a half-renumbered state. There is no cross-repo transaction —
    /// git itself is the recovery mechanism, and the thrown message on a partial failure names every
    /// repo already written, so the user knows exactly what to review.</para>
    /// </summary>
    public RecordEditResult RenumberRecord(PluginKey plugin, string formKey, string? requestedFormKey = null)
    {
        if (RefuseIfBlocked(plugin, out var modFolder) is { } blocked) return blocked;

        var index = sessions.Index;
        if (index == null)
            return RecordEditResult.Refused(RecordEditRefusal.RecordNotFound, "No session is loaded.");

        var document = index.GetDocument(formKey, plugin);
        if (document == null)
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.RecordNotFound, $"{plugin.Name} does not hold record {formKey}.");
        }

        var originatingPlugin = FormKey.Factory(formKey).ModKey.FileName.String;
        if (!originatingPlugin.Equals(plugin.Name, StringComparison.OrdinalIgnoreCase))
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.NotNativeRecord,
                $"{formKey} is an override in {plugin.Name} — {originatingPlugin} originated it. " +
                $"Renumber it there instead.");
        }

        if (ResolveTargetFormKey(index, plugin, requestedFormKey, out var targetFormKey) is { } refusedTarget) return refusedTarget;

        // Every distinct record that references formKey, source-record-deduplicated: GetReferencedBy
        // is one row per (source record, field), and a record referencing the target through two
        // fields still only needs its source file rewritten once — the body-level replace below fixes
        // every occurrence in one write.
        var referencers = index.GetReferencedBy(formKey)
            .Select(r => (FormKey: r.FormKey, Plugin: new PluginKey(r.Plugin, r.Origin)))
            .Distinct()
            .ToList();

        var untrackedReferencers = referencers
            .Select(r => r.Plugin)
            .Distinct()
            .Where(p => ModFolders.TrackedOf(sessions.Session, p) == null)
            .Select(p => p.Name)
            .Distinct()
            .OrderBy(n => n, StringComparer.OrdinalIgnoreCase)
            .ToList();
        if (untrackedReferencers.Count > 0)
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.UntrackedReferencer,
                $"{formKey} is referenced by untracked plugin(s) {string.Join(", ", untrackedReferencers)}, " +
                "so the renumber cannot rewrite their FormLinks. Track them first, then try again.");
        }

        var release = sessions.Session!.GameRelease;
        var writtenRepos = new List<string>();
        try
        {
            foreach (var (referencerFormKey, referencerPlugin) in referencers)
            {
                var referencerModFolder = ModFolders.TrackedOf(sessions.Session, referencerPlugin)!;
                RewriteReferenceField(index, referencerPlugin, referencerModFolder, referencerFormKey, formKey, targetFormKey);
                writtenRepos.Add($"{referencerPlugin.Name} ({referencerPlugin.Origin})");
            }

            RenumberTheRecordItself(index, plugin, modFolder, formKey, targetFormKey, release);
            writtenRepos.Add($"{plugin.Name} ({plugin.Origin})");
        }
        catch (Exception ex)
        {
            // Q5(b): names exactly which repos already carry working-tree dirt from this partial
            // cascade — every one of them is independently reviewable and revertable in the Source
            // Control panel, which is the whole reason write order (referencers first, target last)
            // matters: nothing here is a half-renumbered *target* record, only whichever referencers
            // got as far as this exception. Deliberately unfiltered (not `when (ex is IOException or
            // UnauthorizedAccessException)`): a concurrent external change mid-cascade — another
            // process deleting a referencer between GetReferencedBy and its own rewrite, say — throws
            // RewriteReferenceField's/RenumberTheRecordItself's own InvalidOperationException, and
            // that must carry this same written-repos disclosure rather than silently losing it by
            // falling through this catch to the endpoint's *different* InvalidOperationException
            // handler ("no usable session" — a different question entirely, and a misleading answer
            // to this one). Rethrown as IOException, always, regardless of the original exception's
            // type, so this reaches the client as the same 500 every other write-path fault does,
            // carrying this richer message instead of the bare one.
            throw new IOException(
                $"Renumbering {formKey} to {targetFormKey} failed after writing to: {string.Join(", ", writtenRepos)}. " +
                "Those repos now hold working-tree dirt from this partial renumber — review and revert " +
                $"in the Source Control panel as needed. Underlying error: {ex.Message}", ex);
        }
        finally
        {
            // #422: on both outcomes, not just success — a mid-cascade failure still leaves whatever
            // referencer rewrites already landed (writtenRepos) durably on disk before the throw above,
            // and _filter must not stay stale for those just because the record's own rewrite is what
            // failed. Re-applied once rather than per write — cheaper and no less correct, since
            // SetFilter re-derives the full matching set regardless of how many rows moved since it was
            // last run.
            sessions.ReapplyFilter();
        }

        logger.LogInformation(
            "Renumbered {OldFormKey} to {NewFormKey} in {Plugin} ({Origin}), rewriting {Count} referencing record(s)",
            formKey, targetFormKey, plugin.Name, plugin.Origin, referencers.Count);
        return RecordEditResult.Success(targetFormKey);
    }

    /// <summary>One referencing record's source file, mechanically rewritten to point at the new
    /// FormKey — a whole-body string replace rather than a field-by-field walk, so it also reaches
    /// VMAD Object properties and condition Form parameters (never checked by the reflected-column
    /// <see cref="ValidateFormLinks"/> path, but just as real a reference here).</summary>
    private static void RewriteReferenceField(
        IRecordIndex index, PluginKey referencerPlugin, string referencerModFolder,
        string referencerFormKey, string oldFormKey, string newFormKey)
    {
        var referencerDoc = index.GetDocument(referencerFormKey, referencerPlugin)
            ?? throw new InvalidOperationException(
                $"{referencerPlugin.Name} no longer holds {referencerFormKey} mid-renumber.");

        var relativePath = SourceRecordPath.For(referencerPlugin.Name, referencerDoc.RecordType, referencerFormKey);
        var sourcePath = Path.Combine(referencerModFolder, relativePath);
        var body = File.Exists(sourcePath) ? File.ReadAllText(sourcePath) : referencerDoc.Body!;
        var newBody = body.Replace(oldFormKey, newFormKey, StringComparison.Ordinal);

        File.WriteAllText(sourcePath, newBody);
        index.ApplyWorkingTreeChanges(referencerPlugin, [(referencerFormKey, newBody)]);
    }

    /// <summary>The delete+create pair itself — re-reads the source fresh (rather than trusting the
    /// caller's earlier snapshot) so a self-reference <see cref="RewriteReferenceField"/> already
    /// rewrote above is reflected in the body this reserializes under the new FormKey.</summary>
    private void RenumberTheRecordItself(
        IRecordIndex index, PluginKey plugin, string modFolder, string oldFormKey, string newFormKey, GameRelease release)
    {
        var document = index.GetDocument(oldFormKey, plugin)
            ?? throw new InvalidOperationException($"{plugin.Name} no longer holds {oldFormKey} mid-renumber.");
        var oldRelativePath = SourceRecordPath.For(plugin.Name, document.RecordType, oldFormKey);
        var oldSourcePath = Path.Combine(modFolder, oldRelativePath);

        var record = ReadRecordFromSource(oldSourcePath, document, release);
        ((IMajorRecordInternal)record).FormKey = FormKey.Factory(newFormKey);

        var newRelativePath = SourceRecordPath.For(plugin.Name, document.RecordType, newFormKey);
        var newSourcePath = Path.Combine(modFolder, newRelativePath);
        var newBody = _codec.SerializeToBytesAsync(record, release).GetAwaiter().GetResult();
        _codec.SerializeAsync(record, newSourcePath, release).GetAwaiter().GetResult();

        index.CreateWorkingTreeRecord(plugin, newFormKey, document.RecordType, Encoding.UTF8.GetString(newBody));

        if (File.Exists(oldSourcePath)) File.Delete(oldSourcePath);
        index.ApplyWorkingTreeChanges(plugin, [(oldFormKey, null)]);
    }

    /// <summary>
    /// #427's both-refs collision-safety: <paramref name="formKey"/> must be held at neither
    /// <see cref="RecordRef.Effective"/> nor <see cref="RecordRef.Head"/> — the same rule
    /// <see cref="IRecordIndex.CreateWorkingTreeRecord"/> itself enforces (it throws rather than
    /// silently overwrite), checked here first so a collision reads as a typed refusal instead of an
    /// unhandled exception reaching the endpoint.
    /// </summary>
    private static bool IsFreeAtBothRefs(IRecordIndex index, PluginKey plugin, string formKey) =>
        index.GetDocument(formKey, plugin) == null && index.At(RecordRef.Head).GetDocument(formKey, plugin) == null;

    /// <summary>
    /// #427: the target-FormKey resolution <see cref="CreateRecord"/> and <see cref="RenumberRecord"/>
    /// both need — a caller-typed target (xEdit's own typed-FormID path: validated native to
    /// <paramref name="plugin"/>, then collision-checked at both refs) when
    /// <paramref name="requestedFormKey"/> is given, else the both-refs next-free auto-allocation.
    ///
    /// <para>Null means resolved: <paramref name="targetFormKey"/> carries the FormKey to use.
    /// Non-null is the refusal to return as-is — <paramref name="targetFormKey"/> is <c>""</c> in
    /// that case, the same "assign a harmless placeholder in the refused branch" shape
    /// <see cref="RefuseIfBlocked"/> already uses for its own <c>out</c> parameter, so this stays a
    /// plain non-nullable <see cref="string"/> rather than forcing every call site to null-check it
    /// a second time after already checking the return value.</para>
    /// </summary>
    private RecordEditResult? ResolveTargetFormKey(
        IRecordIndex index, PluginKey plugin, string? requestedFormKey, out string targetFormKey)
    {
        if (requestedFormKey != null)
        {
            if (RefuseIfNotNativeTarget(requestedFormKey, plugin) is { } notNative)
            {
                targetFormKey = "";
                return notNative;
            }
            if (!IsFreeAtBothRefs(index, plugin, requestedFormKey))
            {
                targetFormKey = "";
                return RecordEditResult.Refused(
                    RecordEditRefusal.FormKeyCollision,
                    $"{requestedFormKey} is already held by a record in {plugin.Name} at some ref.");
            }
            targetFormKey = requestedFormKey;
            return null;
        }

        var allocated = NextFreeNativeFormId(index, plugin, sessions.Session!.GetMod(plugin.Name, plugin.Origin!));
        if (allocated != null)
        {
            targetFormKey = allocated;
            return null;
        }

        targetFormKey = "";
        return RecordEditResult.Refused(RecordEditRefusal.FormKeySpaceExhausted, FormKeySpaceExhaustedMessage(plugin));
    }

    /// <summary>
    /// #427: a caller-typed target FormKey (xEdit's own typed-FormID path, on both create and
    /// renumber) must belong to <paramref name="plugin"/>'s own ModKey — the source path a native
    /// record's FormKey embeds is exactly <paramref name="plugin"/>'s own directory, so a foreign
    /// ModKey would land a record physically inside this plugin's source tree while claiming to
    /// originate somewhere else, which is indistinguishable from a corrupt override once written.
    /// xEdit's own Add/renumber gestures have no way to claim a foreign FormID either — this is not
    /// a new restriction, only this seam refusing to silently accept what the UI never offered.
    /// Reuses <see cref="RecordEditRefusal.NotNativeRecord"/>: both cases are "this operation only
    /// ever touches this plugin's own native FormKey space."
    /// </summary>
    private static RecordEditResult? RefuseIfNotNativeTarget(string requestedFormKey, PluginKey plugin)
    {
        var requestedOwner = FormKey.Factory(requestedFormKey).ModKey.FileName.String;
        if (requestedOwner.Equals(plugin.Name, StringComparison.OrdinalIgnoreCase)) return null;

        return RecordEditResult.Refused(
            RecordEditRefusal.NotNativeRecord,
            $"{requestedFormKey} belongs to {requestedOwner}, not {plugin.Name} — a requested FormKey " +
            "must be native to the plugin it is being created or renumbered into.");
    }

    /// <summary>
    /// The next unused local FormID under <paramref name="plugin"/>'s own ModKey — unioning the
    /// native FormKeys (<see cref="IRecordReads.GetNativeFormKeys"/>) this plugin holds at
    /// <see cref="RecordRef.Effective"/> (committed natives, plus any uncompiled prior create) and at
    /// <see cref="RecordRef.Head"/> (a native the working tree has since deleted, whose ID must still
    /// not be reused ahead of compile). Floored at the game's own recommended starting FormID
    /// (<see cref="IModGetter.GetDefaultInitialNextFormID"/>, mirroring
    /// <c>SessionManager.SafeNextFormId</c>'s identical floor) when <paramref name="mod"/> is
    /// available, else the conservative literal floor every Bethesda game shares.
    ///
    /// <para>Null means the plugin's FormKey space is exhausted (every local ID up to
    /// <c>0xFFFFFF</c> already in use) — a typed refusal at both call sites
    /// (<see cref="RecordEditRefusal.FormKeySpaceExhausted"/>), not an exception: a full plugin
    /// refusing a new record is an ordinary, expected outcome (review finding #1), the same doctrine
    /// as every other refusal on this write path, not a fault for the caller's generic exception
    /// handling to (mis)classify as "no usable session."</para>
    /// </summary>
    private static string? NextFreeNativeFormId(IRecordIndex index, PluginKey plugin, IModGetter? mod)
    {
        var floor = mod?.GetDefaultInitialNextFormID() ?? 0x800u;
        var highest = index.GetNativeFormKeys(plugin)
            .Concat(index.At(RecordRef.Head).GetNativeFormKeys(plugin))
            .Select(LocalId)
            .DefaultIfEmpty(0u)
            .Max();
        var next = Math.Max(floor, highest + 1);
        return next > 0xFFFFFF ? null : $"{next:X6}:{plugin.Name}";
    }

    private static string FormKeySpaceExhaustedMessage(PluginKey plugin) =>
        $"{plugin.Name} has exhausted its FormKey space — every local FormID up to 0xFFFFFF is already in use.";

    private static uint LocalId(string formKey) =>
        uint.Parse(formKey[..formKey.IndexOf(':')], NumberStyles.HexNumber, CultureInfo.InvariantCulture);

    /// <summary>
    /// #427: the same both-refs allocator <see cref="CreateRecord"/>/<see cref="RenumberRecord"/> use
    /// internally, exposed read-only so the Renumber gesture's FormID input box can prefill a
    /// suggested value the way xEdit's own "New FormID generated" flow does — never a write, and no
    /// tracked/untracked gate: it is pure arithmetic over already-indexed state, harmless to ask for
    /// a plugin nobody can edit yet.
    ///
    /// <para>Returns the same typed <see cref="RecordEditResult"/> shape every other entry point on
    /// this write path does (review finding #2: brought to the same standard as
    /// <see cref="CreateRecord"/>/<see cref="RenumberRecord"/>, rather than a bespoke nullable-string
    /// contract) — <see cref="RecordEditRefusal.RecordNotFound"/> when no session is loaded (matching
    /// every sibling method's own "No session is loaded." refusal here) and
    /// <see cref="RecordEditRefusal.FormKeySpaceExhausted"/> when the plugin's FormKey space is full;
    /// <see cref="RecordEditResult.NewFormKey"/> carries the suggestion on success.</para>
    /// </summary>
    public RecordEditResult PeekNextFreeFormKey(PluginKey plugin)
    {
        var index = sessions.Index;
        if (index == null)
            return RecordEditResult.Refused(RecordEditRefusal.RecordNotFound, "No session is loaded.");

        var formKey = NextFreeNativeFormId(index, plugin, sessions.Session!.GetMod(plugin.Name, plugin.Origin!));
        return formKey != null
            ? RecordEditResult.Success(formKey)
            : RecordEditResult.Refused(RecordEditRefusal.FormKeySpaceExhausted, FormKeySpaceExhaustedMessage(plugin));
    }

    /// <summary>
    /// AC3 / ADR-0020 (kept, relocated): Dangling and Type-Mismatched FormLinks are blocked at edit
    /// time, before anything is written. Returns the diagnostic, or null when the value is clean.
    ///
    /// <para><b>Effective state is what this resolves against</b>, which is what AC3 requires: a
    /// record the working tree deleted still exists at Head, and a check reading committed state
    /// would let the user point a link at something that will not be there when this compiles.
    /// Worth being precise about the mechanism, because it is not this call site's choice —
    /// <see cref="IRecordReads.Resolve"/> answers from <c>form_lookup</c>, which carries no ref
    /// dimension at all and tracks Effective at <i>both</i> refs by design (see
    /// <see cref="IRecordIndex.At"/>). So the property is enforced by
    /// <see cref="IRecordIndex.ApplyWorkingTreeChanges"/> keeping that table in step with the
    /// documents it was extracted from, not by naming a ref here; asking at Head would give the same
    /// answer, and the test that would catch a regression is the one that deletes a record's lookup
    /// row.</para>
    ///
    /// <para>The whole field is validated, not only the part that changed — the same scope
    /// <c>ReferenceValidator</c> had before #410, and the only coherent one for a complex field that
    /// is written atomically. This walks the <i>incoming</i> value rather than the applied record so
    /// that what is checked is exactly what the caller asked to create.</para>
    ///
    /// <para>Scope is the reflected columns, matching the pre-#410 validator exactly. VMAD Object
    /// properties and condition Form parameters carry FormKeys too and are not checked here; they
    /// were not checked before either, and widening that is its own change with its own evidence.</para>
    /// </summary>
    private static string? ValidateFormLinks(
        IRecordIndex index,
        IReadOnlyDictionary<string, RecordTableSchema> schemas,
        string recordType,
        string fieldPath,
        JsonElement value)
    {
        if (!schemas.TryGetValue(recordType, out var schema)) return null;
        var col = schema.RecordColumns.FirstOrDefault(c => c.Name == fieldPath);
        if (col == null) return null;

        // The same builder the read model renders check errors from, so "what the editor flags in a
        // loaded plugin" and "what the editor refuses to create" are one definition of a broken link,
        // not two that can drift.
        return CheckErrorBuilder.Build(col.ToFieldMetadata(), value, index.Resolve);
    }

    /// <summary>The Track command as the palette actually shows it — <c>package.json</c>'s title
    /// ("Track…", U+2026) under its category ("Modbench"). One constant, because a signpost naming
    /// a command the user cannot find is worse than no signpost at all.</summary>
    internal const string TrackCommandTitle = "Modbench: Track\u2026";

    /// <summary>
    /// The two refusals every entry point on this single write path must inherit, in order \u2014
    /// untracked (AC4), then #417 exit path 3's external-change deferral \u2014 checked here once so
    /// <see cref="EditField"/>, <see cref="DeleteRecord"/> and <see cref="CreateRecord"/> cannot
    /// drift on either. Null means neither refusal applies, and <paramref name="modFolder"/> is the
    /// mod folder every caller needs next.
    ///
    /// <para>INVARIANT for future write gestures: every new one must enter through a method on this
    /// class that calls this helper first \u2014 never call <see cref="IRecordIndex.ApplyWorkingTreeChanges"/>
    /// or <see cref="IRecordIndex.CreateWorkingTreeRecord"/> some other way, which is exactly what
    /// <c>RecordEditServiceExternalChangeDeferralTests</c>' rival proved bypasses the deferral
    /// refusal entirely when this check is skipped.</para>
    /// </summary>
    private RecordEditResult? RefuseIfBlocked(PluginKey plugin, out string modFolder)
    {
        if (ModFolders.TrackedOf(sessions.Session, plugin) is not { } folder)
        {
            modFolder = "";
            return RefuseUntracked(plugin);
        }
        modFolder = folder;

        // #417 exit path 3: a same-plugin external-change question left unanswered refuses every
        // gesture on the single write path \u2014 checked before anything else, so neither of the write
        // path's two doors fires: the source file is never touched, and the index call that would
        // tell the DB about it is never reached.
        return ExternalChangeDeferral.Pending(folder, plugin.Name) is { } pendingQuestion
            ? RecordEditResult.Refused(RecordEditRefusal.ExternalChangePending, pendingQuestion)
            : null;
    }

    // AC4: two refusals, because there are two different ways out and a message that named neither
    // would be the "silent dead UI" this ticket exists to avoid.
    private RecordEditResult RefuseUntracked(PluginKey plugin) =>
        ModFolders.Of(sessions.Session, plugin) is null
            ? RecordEditResult.Refused(
                RecordEditRefusal.PluginHasNoModFolder,
                $"{plugin.Name} is a base-game plugin with no mod folder, so it cannot be tracked. " +
                "Author a patch plugin and edit the override there.")
            : RecordEditResult.Refused(
                RecordEditRefusal.PluginNotTracked,
                $"{plugin.Name} is not tracked, so it is read-only. " +
                // The palette entry verbatim: package.json contributes title "Track…" under
                // category "Modbench", which VS Code renders as "Modbench: Track…". Naming a
                // command that does not exist is the same dead end AC4 exists to prevent, so the
                // tests assert this string exactly rather than merely containing "Track".
                $"Run \"{TrackCommandTitle}\" on it once to start editing.");

    private static RecordEditResult RefuseFieldOutcome(FieldApplyOutcome outcome, string fieldPath, string recordType) =>
        outcome == FieldApplyOutcome.ReadOnly
            ? RecordEditResult.Refused(RecordEditRefusal.FieldReadOnly, $"'{fieldPath}' is read-only.")
            : RecordEditResult.Refused(RecordEditRefusal.FieldNotFound, $"'{recordType}' has no field '{fieldPath}'.");

    /// <summary>
    /// The record as its source text has it. Falls back to the indexed body only when the file is
    /// missing entirely — never-assume-exclusive-ownership (root CLAUDE.md): a tracked mod's source
    /// tree is complete when Track leaves it, but anything may have removed a file since, and
    /// refusing the edit would strand the user with no way to put the record back.
    /// </summary>
    private IMajorRecord ReadRecordFromSource(string sourcePath, RecordDocument document, GameRelease release)
    {
        // #450: both reads state the record's type rather than relying on the document to name it —
        // the same document either way, so the same record_type identifies it either way.
        if (File.Exists(sourcePath))
            return _codec.DeserializeAsync(sourcePath, release, document.RecordType).GetAwaiter().GetResult();

        logger.LogWarning(
            "Source file {SourcePath} is missing; editing from the indexed document and rewriting it", sourcePath);
        return _codec
            .DeserializeFromBytesAsync(Encoding.UTF8.GetBytes(document.Body!), release, document.RecordType)
            .GetAwaiter().GetResult();
    }
}
