using System.Globalization;
using System.Text;
using System.Text.Json;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Meta;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Edits;

/// <summary>The write side's shared concerns (ADR-0046): target resolution, its pre-write refusals,
/// rename on an EditorID change, and FormKey allocation. An internal seam, tested through the
/// gestures.</summary>
internal sealed class WriteTargets(
    LoadOrderHolder loadOrder,
    IModImporter importer,
    RecordTextCodec codec,
    SchemaReflector schemaReflector,
    ILogger logger)
{
    /// <summary>The palette title verbatim (package.json's "Track…" under category "Modbench"); a signpost
    /// naming a command the user cannot find is worse than none.</summary>
    internal const string TrackCommandTitle = "Modbench: Track\u2026";

    internal readonly record struct EditTarget(
        GameRelease Release, RecordIdentity Identity, SourceUnit Unit, SourceRepository Repository);

    // The working tree is the only thing asked (ADR-0046 invariant 7): a second edit builds on the
    // first, and no document comes from the Index. The copy gestures read the source instead.
    internal RecordEditResult? ResolveEditTarget(PluginKey plugin, string formKey, out EditTarget target)
    {
        target = default;

        if (RefuseIfBlocked(plugin, out _, out var repository) is { } blocked) return blocked;

        var release = loadOrder.Current.GameRelease;
        RecordIdentity? found;
        try
        {
            found = repository.IdentityOf(plugin, formKey, schemaReflector.GetSchemas(release));
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            // Naming this record means reading the document that carries it, and the codec is the only
            // reader of one: its own words are the reason.
            return RefuseUnreadable(formKey, ex.Message);
        }

        if (found is not { } identity)
        {
            // A document named after this record whose text is not one: present, so this is not
            // absence, and the reader's words are the whole reason.
            if (repository.UnreadableDocumentFor(plugin, formKey) is { } why) return RefuseUnreadable(formKey, why);

            return RecordEditResult.Refused(
                RecordEditRefusal.RecordNotFound,
                $"No document in {plugin.Name}'s source tree holds {formKey}, and no record's document " +
                "carries it.");
        }

        // An embedded child (a placed ref, landscape, navmesh, top cell) resolves to its parent's file.
        if (repository.Locate(plugin, identity) is not { } unit)
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.SourceUnitNotFound,
                $"No document in {plugin.Name}'s source tree holds {formKey}, and no record's document " +
                "carries it. Something moved or removed it outside Modbench \u2014 check the Source Control panel.");
        }

        target = new EditTarget(release, identity, unit, repository);
        return null;
    }

    internal readonly record struct CopyTarget(
        CopySource Source, RecordIdentity Identity, RecordCopy.Destination Destination, GameRelease Release, string Body);

    // Asymmetric by construction: the write-path gate checks the destination, the source answers for
    // its own record. The text is read before anything is written, because a record the codec cannot
    // read would land as a stub.
    internal RecordEditResult? ResolveCopySource(
        PluginKey destinationPlugin, PluginKey sourcePlugin, string formKey, out CopyTarget target)
    {
        target = default;

        if (RefuseIfBlocked(destinationPlugin, out var destinationModFolder, out var destinationRepository)
            is { } blocked) return blocked;

        var release = loadOrder.Current.GameRelease;
        var source = new CopySource(sourcePlugin, loadOrder.Current, importer, codec, schemaReflector);
        try
        {
            if (source.Identity(formKey) is not { } identity)
            {
                source.Dispose();
                return RecordEditResult.Refused(
                    RecordEditRefusal.RecordNotFound, $"{sourcePlugin.Name} does not hold record {formKey}.");
            }

            target = new CopyTarget(
                source, identity,
                new RecordCopy.Destination(destinationRepository, destinationPlugin, destinationModFolder),
                release, source.Body(identity));
            return null;
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            source.Dispose();
            return RefuseUnreadableCopySource(formKey, source.Diagnose(ex));
        }
    }

    // A record's own descendants are inside its text, so one unreadable response refuses its topic
    // here too.
    private static RecordEditResult RefuseUnreadableCopySource(string formKey, string why) =>
        RecordEditResult.Refused(
            RecordEditRefusal.RecordParseFailed,
            $"{formKey} cannot be read, so copying it would land a stub holding only its FormKey and " +
            $"EditorID rather than the record: {why}");

    // INVARIANT: every record write gesture enters here first, and this is the only place the
    // deferral refusal is raised. A write that reaches a source tree without it is not refused while
    // an external-change question is unanswered.
    internal RecordEditResult? RefuseIfBlocked(PluginKey plugin, out string modFolder, out SourceRepository repository)
    {
        modFolder = "";
        repository = null!;

        if (ModFolders.Of(loadOrder.Current, plugin) is not { } folder) return RefuseUntracked(plugin);
        if (SourceRepository.Open(folder, loadOrder.Current.GameRelease) is not { } opened) return RefuseUntracked(plugin);

        (modFolder, repository) = (folder, opened);

        // Checked before anything else, so the source file is never reached.
        return ExternalChangeDeferral.Unanswered(folder, plugin.Name) is { } question
            ? RecordEditResult.Refused(RecordEditRefusal.ExternalChangeUnanswered, question)
            : null;
    }

    // Two refusals, because there are two different ways out and a message that named neither
    // would be silent dead UI.
    private RecordEditResult RefuseUntracked(PluginKey plugin) =>
        ModFolders.Of(loadOrder.Current, plugin) is null
            ? RecordEditResult.Refused(
                RecordEditRefusal.PluginHasNoModFolder,
                $"{plugin.Name} is a base-game plugin with no mod folder, so it cannot be tracked. " +
                "Author a patch plugin and edit the override there.")
            : RecordEditResult.Refused(
                RecordEditRefusal.PluginNotTracked,
                $"{plugin.Name} is not tracked, so it is read-only. " +
                // The palette entry verbatim; naming a command that does not exist is its own dead end.
                $"Run \"{TrackCommandTitle}\" on it once to start editing.");

    // Everything the allocator needs about one plugin, read from its tree once per gesture: a
    // per-child re-read would walk the whole tree again for every key drawn.
    internal readonly record struct Allocator(
        PluginKey Plugin, GameRelease Release, bool IsLight, bool EslFlagIsRemovable,
        IReadOnlySet<string> Effective, IReadOnlySet<string> Head)
    {
        internal bool HoldsAtEitherRef(string formKey) => Effective.Contains(formKey) || Head.Contains(formKey);

        internal IEnumerable<string> Taken => Effective.Concat(Head);
    }

    // A tracked copy allocates from its source tree; an untracked one has none, so the Plugin
    // adapter answers from its own bytes, as the form-link resolver's untracked branch does.
    internal Allocator AllocatorFor(RegisteredCopy copy, PluginKey plugin)
    {
        if (ModFolders.Of(loadOrder.Current, plugin) is { } modFolder
            && SourceRepository.Open(modFolder, loadOrder.Current.GameRelease) is { } repository)
        {
            return AllocatorOver(repository, plugin);
        }

        using var opened = importer.Open(copy, loadOrder.Current.GameRelease);
        return AllocatorOver(opened.Getter, plugin);
    }

    // Both refs from the tree alone (ADR-0046 invariant 7): the working tree, plus HEAD, whose IDs a
    // working-tree deletion has not freed until the plugin is compiled.
    internal Allocator AllocatorOver(SourceRepository repository, PluginKey plugin)
    {
        var byRemovableFlag = IsLightByRemovableFlag(repository, plugin);
        return new Allocator(
            plugin,
            loadOrder.Current.GameRelease,
            byRemovableFlag || plugin.Name.EndsWith(".esl", StringComparison.OrdinalIgnoreCase),
            byRemovableFlag,
            repository.NativeFormKeysHeld(plugin),
            repository.NativeFormKeysHeldAt(plugin, "HEAD"));
    }

    // The copy's own records are the whole answer: it has no uncompiled state, so no second ref.
    private Allocator AllocatorOver(IModGetter mod, PluginKey plugin) =>
        new(plugin,
            loadOrder.Current.GameRelease,
            PluginFlagPredicates.IsLight(mod, plugin.Name),
            mod.IsSmallMaster,
            mod.EnumerateMajorRecords()
                .Select(r => r.FormKey)
                .Where(k => k.ModKey.FileName.String.Equals(plugin.Name, StringComparison.OrdinalIgnoreCase))
                .Select(k => k.ToString())
                .ToHashSet(StringComparer.OrdinalIgnoreCase),
            new HashSet<string>(StringComparer.OrdinalIgnoreCase));

    // One allocator read per gesture, for the gestures that draw a single key. The embedded copy
    // draws several from one allocator and calls the overload below directly.
    internal RecordEditResult? ResolveTargetFormKey(
        SourceRepository repository, PluginKey plugin, string? requestedFormKey, out string targetFormKey) =>
        ResolveTargetFormKey(AllocatorOver(repository, plugin), requestedFormKey, out targetFormKey);

    // Non-null is the refusal; targetFormKey is "" then, so call sites need no second null-check.
    // taken: keys this gesture drew but has not written, so one document's records get distinct keys.
    internal static RecordEditResult? ResolveTargetFormKey(
        Allocator allocator, string? requestedFormKey, out string targetFormKey, IReadOnlySet<string>? taken = null)
    {
        var plugin = allocator.Plugin;
        if (requestedFormKey != null)
        {
            if (RefuseIfNotNativeTarget(requestedFormKey, plugin, allocator.IsLight) is { } notNative)
            {
                targetFormKey = "";
                return notNative;
            }
            if (allocator.HoldsAtEitherRef(requestedFormKey))
            {
                targetFormKey = "";
                return RecordEditResult.Refused(
                    RecordEditRefusal.FormKeyCollision,
                    $"{requestedFormKey} is already held by a record in {plugin.Name} at some ref.");
            }
            targetFormKey = requestedFormKey;
            return null;
        }

        var allocated = NextFreeNativeFormId(allocator, allocator.IsLight, taken);
        if (allocated != null)
        {
            targetFormKey = allocated;
            return null;
        }

        targetFormKey = "";
        // The ESL cap, not the FormKey space, is exhausted, and the light-ness is the removable header
        // flag: surfaced as a typed marker, the same way out compile offers.
        var eslContradiction = allocator.IsLight
            && allocator.EslFlagIsRemovable
            && NextFreeNativeFormId(allocator, isLight: false, taken) != null;
        return RecordEditResult.Refused(
            RecordEditRefusal.FormKeySpaceExhausted,
            FormKeySpaceExhaustedMessage(plugin, allocator.IsLight, eslContradiction),
            eslContradiction);
    }

    // The header document in the working tree is the truth (ADR-0041), so a flag flipped this session
    // caps minting immediately. A .esl extension also reads as light, but no header edit can un-flag it.
    private static bool IsLightByRemovableFlag(SourceRepository repository, PluginKey plugin)
    {
        var headerFormKey = PluginHeader.FormKeyFor(ModKey.FromFileName(plugin.Name));
        var header = repository.Get(plugin, new RecordIdentity(headerFormKey, PluginHeader.RecordType, null));
        return header?.Body is { } body && HeaderDocument.IsLight(Encoding.UTF8.GetBytes(body));
    }

    // A foreign ModKey would land a record inside this plugin's tree while claiming another origin,
    // indistinguishable from a corrupt override; xEdit never offers one either. Range is checked
    // after ownership.
    private static RecordEditResult? RefuseIfNotNativeTarget(string requestedFormKey, PluginKey plugin, bool isLight)
    {
        var parsed = FormKey.Factory(requestedFormKey);
        var requestedOwner = parsed.ModKey.FileName.String;
        if (!requestedOwner.Equals(plugin.Name, StringComparison.OrdinalIgnoreCase))
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.NotNativeRecord,
                $"{requestedFormKey} belongs to {requestedOwner}, not {plugin.Name} — a requested FormKey " +
                "must be native to the plugin it is being created or renumbered into.");
        }

        if (isLight && parsed.ID > PluginFlagPredicates.LightLocalFormIdCap)
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.LightPluginFormIdOutOfRange,
                $"{requestedFormKey} exceeds {plugin.Name}'s ESL local FormID range — a light-flagged " +
                $"plugin can only address local FormIDs up to 0x{PluginFlagPredicates.LightLocalFormIdCap:X}. " +
                "Choose a FormID within that range, or un-flag the plugin as ESL.");
        }

        return null;
    }

    // Unions the working tree (committed plus uncompiled creates) and HEAD (natives the working tree
    // deleted, whose IDs must not be reused before compile). Null means exhausted.
    internal static string? NextFreeNativeFormId(Allocator allocator, bool isLight, IReadOnlySet<string>? taken = null)
    {
        // GetDefaultInitialNextFormID is this constant for every mod of a release: its own default
        // argument takes the branch that returns the high range, loaded plugin or not.
        var floor = GameConstants.Get(allocator.Release).DefaultHighRangeFormID;
        var highest = allocator.Taken
            .Concat(taken ?? Enumerable.Empty<string>())
            .Select(LocalId)
            .DefaultIfEmpty(0u)
            .Max();
        var next = Math.Max(floor, highest + 1);
        var cap = isLight ? PluginFlagPredicates.LightLocalFormIdCap : FormID.FullIdMask;
        return next > cap ? null : $"{next:X6}:{allocator.Plugin.Name}";
    }

    internal static string FormKeySpaceExhaustedMessage(PluginKey plugin, bool isLight, bool eslContradiction = false)
    {
        if (eslContradiction)
        {
            return $"{plugin.Name} has exhausted its ESL FormKey space — every local FormID up to 0xFFF is " +
                "already in use (a light-flagged plugin's addressable range) — but native space remains " +
                "free above it. Remove the ESL flag to keep creating records there.";
        }
        return isLight
            ? $"{plugin.Name} has exhausted its ESL FormKey space — every local FormID up to 0xFFF is " +
              "already in use (a light-flagged plugin's addressable range). Un-flag it as ESL to use " +
              "the full 0xFFFFFF range."
            : $"{plugin.Name} has exhausted its FormKey space — every local FormID up to 0xFFFFFF is already in use.";
    }

    private static uint LocalId(string formKey) =>
        uint.Parse(formKey[..formKey.IndexOf(':')], NumberStyles.HexNumber, CultureInfo.InvariantCulture);

    /// <summary>A source unit's leaf name carries its record's EditorID, so an EditorID change moves
    /// the unit. Never a gesture's only write, so a crash on either side of it leaves the record
    /// findable by FormKey.</summary>
    internal void RenameTo(SourceRepository repository, PluginKey plugin, RecordIdentity target, string? newEditorId)
    {
        if (repository.Rename(plugin, target, newEditorId) is { } newLeaf && logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "EditorID changed on {FormKey}; moved its source unit from {Old} to {New}",
                target.FormKey, target.EditorId, newLeaf);
        }
    }

    /// <summary>The EditorID a written document's own text names, which is what the rename follows.</summary>
    internal static string? EditorIdOf(string text)
    {
        using var document = JsonDocument.Parse(text);
        return document.RootElement.TryGetProperty(nameof(IMajorRecordGetter.EditorID), out var editorId)
            && editorId.ValueKind == JsonValueKind.String
            ? editorId.GetString()
            : null;
    }

    // Parse status is not a precondition (ADR-0046 invariant 7): the codec is asked at edit time, and
    // its own words are the reason.
    internal static RecordEditResult RefuseUnreadable(string formKey, string why, string? spelled = null) =>
        new(false, RecordEditRefusal.RecordParseFailed,
            $"{formKey}'s document cannot be read, so nothing can be written to it: {why}", Path: spelled);

    // Refused before any write. Not folded into ResolveEditTarget because Edit reaches the
    // header deliberately. Without it, SourceUnit.IsDirectoryPerRecord (filename-only) answers true
    // for the header and DeleteRecord deletes the plugin's whole source root.
    internal static RecordEditResult? RefuseIfHeader(string recordType) =>
        recordType == PluginHeader.RecordType
            ? RecordEditResult.Refused(
                RecordEditRefusal.HeaderDeleteOrRenumberNotSupported,
                "The plugin header cannot be deleted or renumbered — it is not an ordinary record.")
            : null;

    // CreateRecord and CopyAsNewRecord only: a brand-new record has no containment to resolve to, and
    // choosing one is a UX decision. FolderNameFor is also null for every record with no top-level
    // group of its own, which the message names.
    internal static RecordEditResult? RefuseIfContainerType(string recordType, GameRelease release)
    {
        if (RecordTypeDispatch.For(release).FolderNameFor(recordType) is not null) return null;

        return RecordEditResult.Refused(
            RecordEditRefusal.ContainerRecordNotYetSupported,
            $"'{recordType}' has no source file of its own — it is a container record (Cell, Worldspace) " +
            "or a record embedded in one (a placed reference, landscape, navmesh, dialog topic, branch, " +
            "scene, response). Editing its fields works, and so do deleting and renumbering it; creating " +
            "one from scratch is not supported — a brand-new record has no containment for anything to " +
            "place it into.");
    }
}
