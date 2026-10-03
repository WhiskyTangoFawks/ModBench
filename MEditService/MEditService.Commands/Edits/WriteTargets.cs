using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.SourceAdapter;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Edits;

/// <summary>The write side's shared concerns (target-architecture.d2 medit_core.commands): target resolution, its pre-write refusals,
/// and FormKey allocation. An internal seam, tested through the
/// gestures.</summary>
internal sealed class WriteTargets(
    LoadOrderHolder loadOrder,
    IPluginAdapter adapter,
    RecordTextCodec codec,
    SchemaReflector schemaReflector)
{
    /// <summary>The palette title verbatim (package.json's "Track…" under category "Modbench"); a signpost
    /// naming a command the user cannot find is worse than none.</summary>
    internal const string TrackCommandTitle = "Modbench: Track\u2026";

    // The unit is read before anything is written, so a rename or a delete this gesture performs
    // cannot change the document its messages and logs name.
    internal readonly record struct EditTarget(
        GameRelease Release, RecordIdentity Identity, HoldingUnit Unit, SourceRepository Repository);

    // The working tree is the only thing asked (ADR-0015 invariant 5), so a second edit builds on
    // the first. The copy gestures read the source instead.
    internal RecordEditResult? ResolveEditTarget(PluginAddress plugin, string formKey, out EditTarget target)
    {
        target = default;

        if (RefuseUnlessTrackedAndLoaded(plugin, out var openedRepository) is { } blocked) return blocked;
        var repository = openedRepository
            ?? throw new InvalidOperationException("Expected RefuseUnlessTrackedAndLoaded to open a repository when it does not refuse.");

        var release = loadOrder.Current.GameRelease;
        try
        {
            return ResolveInTheTree(plugin, formKey, repository, release, out target);
        }
        catch (AmbiguousSourceUnitException ex)
        {
            return RecordEditResult.Refused(RecordEditRefusal.AmbiguousSourceUnit, ex.Message);
        }
    }

    private RecordEditResult? ResolveInTheTree(
        PluginAddress plugin, string formKey, SourceRepository repository, GameRelease release, out EditTarget target)
    {
        target = default;
        RecordIdentity? found;
        try
        {
            found = repository.IdentityOf(plugin, formKey, schemaReflector.GetSchemas(release));
        }
        catch (Exception ex) when (ex is not (OutOfMemoryException or AmbiguousSourceUnitException))
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
        if (repository.UnitHolding(plugin, identity) is not { } unit)
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
        PluginAddress destinationPlugin, PluginAddress sourcePlugin, string formKey, out CopyTarget target)
    {
        target = default;

        if (RefuseUnlessTrackedAndLoaded(destinationPlugin, out var openedDestinationRepository)
            is { } blocked) return blocked;
        var destinationRepository = openedDestinationRepository
            ?? throw new InvalidOperationException("Expected RefuseUnlessTrackedAndLoaded to open a repository when it does not refuse.");

        var release = loadOrder.Current.GameRelease;
        var source = new CopySource(sourcePlugin, loadOrder.Current, adapter, codec, schemaReflector);
        CopySource? owned = source;
        try
        {
            if (IdentityIn(source, formKey) is not { } identity)
            {
                return RecordEditResult.Refused(
                    RecordEditRefusal.RecordNotFound, $"{sourcePlugin.Name} does not hold record {formKey}.");
            }

            target = new CopyTarget(
                source, identity,
                new RecordCopy.Destination(destinationRepository, destinationPlugin),
                release, source.Body(identity));
            owned = null;
            return null;
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            return RefuseUnreadableCopySource(formKey, source.Diagnose(ex));
        }
        finally
        {
            owned?.Dispose();
        }
    }

    // A record's own descendants are inside its text, so one unreadable response refuses its topic
    // here too.
    private static RecordEditResult RefuseUnreadableCopySource(string formKey, string why) =>
        RecordEditResult.Refused(
            RecordEditRefusal.RecordParseFailed,
            $"{formKey} cannot be read, so copying it would land a stub holding only its FormKey and " +
            $"EditorID rather than the record: {why}");

    /// <summary>A copy that reads a source-tree document beyond its own record, as an exterior cell's
    /// worldspace, refuses naming that document.</summary>
    internal static RecordEditResult RefuseUnreadableSourceTree(string formKey, string why) =>
        RecordEditResult.Refused(RecordEditRefusal.RecordParseFailed, $"{formKey} cannot be copied: {why} Nothing was written.");

    // The six record gestures enter here first.
    internal RecordEditResult? RefuseUnlessTrackedAndLoaded(PluginAddress plugin, out SourceRepository? repository)
    {
        repository = null;

        if (loadOrder.Current.ModFolderOf(plugin) is not { } folder) return RefuseUntracked(plugin);
        if (SourceRepository.Open(folder, loadOrder.Current.GameRelease) is not { } opened) return RefuseUntracked(plugin);

        repository = opened;
        return RefuseIfNotLoaded(plugin);
    }

    // Tracking is per mod folder and implies neither that the plugin is active nor that it is not
    // (ADR-0012 invariant 5).
    private RecordEditResult? RefuseIfNotLoaded(PluginAddress plugin) =>
        loadOrder.Current.IsActive(plugin)
            ? null
            : RecordEditResult.Refused(
                RecordEditRefusal.PluginNotActive,
                $"{plugin.Name} ({plugin.Origin}) is not active, so the game does not load it and it is " +
                "read-only. Enabling its line, or moving its mod toward the winning end, makes it active.");

    // Two refusals, because there are two different ways out and a message that named neither
    // would be silent dead UI.
    private RecordEditResult RefuseUntracked(PluginAddress plugin) =>
        loadOrder.Current.ModFolderOf(plugin) is null
            ? RecordEditResult.Refused(RecordEditRefusal.PluginHasNoModFolder, NoModFolderMessage(plugin))
            : RecordEditResult.Refused(
                RecordEditRefusal.PluginNotTracked,
                $"{plugin.Name} is not tracked, so it is read-only. " +
                // The palette entry verbatim; naming a command that does not exist is its own dead end.
                $"Run \"{TrackCommandTitle}\" on it once to start editing.");

    // Neither origin's way out is the other's (ADR-0012 invariant 2).
    private static string NoModFolderMessage(PluginAddress plugin) =>
        PluginOrigin.IsOverwrite(plugin.Origin)
            ? $"{plugin.Name} is loaded from Overwrite, an origin and not a mod, so it has no mod " +
              "folder to hold its source. Move it into a mod, then edit it there."
            : $"{plugin.Name} is a base-game plugin with no mod folder, so it cannot be tracked. " +
              "Author a patch plugin and edit the override there.";

    // Everything the allocator needs about one plugin, read from its tree once per gesture: a
    // per-child re-read would walk the whole tree again for every key drawn.
    public readonly record struct Allocator(
        PluginAddress Plugin, GameRelease Release, bool IsLight, bool EslFlagIsRemovable,
        IReadOnlySet<string> Effective, IReadOnlySet<string> Head)
    {
        public bool HoldsAtEitherRef(string formKey) => Effective.Contains(formKey) || Head.Contains(formKey);

        internal IEnumerable<string> Taken => Effective.Concat(Head);
    }

    // Both refs from the tree alone (ADR-0015 invariant 5): the working tree, plus HEAD, whose IDs a
    // working-tree deletion has not freed until the plugin is compiled.
    internal Allocator AllocatorOver(SourceRepository repository, PluginAddress plugin) =>
        AllocatorOver(
            plugin,
            IsLightByRemovableFlag(repository, plugin),
            repository.NativeFormKeysHeld(plugin),
            repository.NativeFormKeysHeldAt(plugin, "HEAD"));

    // A .esl extension also reads as light, and no header edit can un-flag that one.
    private Allocator AllocatorOver(
        PluginAddress plugin, bool byRemovableFlag, IReadOnlySet<string> effective, IReadOnlySet<string> head) =>
        new(plugin,
            loadOrder.Current.GameRelease,
            byRemovableFlag || plugin.Name.EndsWith(".esl", StringComparison.OrdinalIgnoreCase),
            byRemovableFlag,
            effective,
            head);

    // One allocator read per gesture, for the gestures that draw a single key. The embedded copy
    // draws several from one allocator and calls the overload below directly.
    internal RecordEditResult? ResolveTargetFormKey(
        SourceRepository repository, PluginAddress plugin, string? requestedFormKey, out string targetFormKey) =>
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
        var freeAboveTheLightCap = allocator.IsLight
            && allocator.EslFlagIsRemovable
            && NextFreeNativeFormId(allocator, isLight: false, taken) != null;
        return RecordEditResult.Refused(
            RecordEditRefusal.FormKeySpaceExhausted,
            FormKeySpaceExhaustedMessage(plugin, allocator.IsLight, freeAboveTheLightCap));
    }

    // The working tree's header document decides (ADR-0007 invariant 3), so a flag flipped this
    // session caps minting immediately.
    private static bool IsLightByRemovableFlag(SourceRepository repository, PluginAddress plugin)
    {
        var headerFormKey = PluginHeader.FormKeyFor(ModKey.FromFileName(plugin.Name));
        var header = repository.Get(plugin, new RecordIdentity(headerFormKey, PluginHeader.RecordType, null));
        return header?.Body is { } body && HeaderDocument.IsLight(Encoding.UTF8.GetBytes(body));
    }

    // A foreign ModKey would land a record inside this plugin's tree while claiming another origin,
    // indistinguishable from a corrupt override; xEdit never offers one either. Range is checked
    // after ownership.
    private static RecordEditResult? RefuseIfNotNativeTarget(string requestedFormKey, PluginAddress plugin, bool isLight)
    {
        var parsed = FormKey.Factory(requestedFormKey);
        var requestedOwner = parsed.ModKey.FileName.String;
        if (!requestedOwner.Equals(plugin.Name, StringComparison.OrdinalIgnoreCase))
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.NotNativeRecord,
                $"{requestedFormKey} belongs to {requestedOwner}, not {plugin.Name} — a requested FormKey " +
                "must be native to the plugin that is to hold it.");
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
        var floor = PluginFlagPredicates.HighRangeFormIdFloor(allocator.Release);
        var highest = allocator.Taken
            .Concat(taken ?? Enumerable.Empty<string>())
            .Select(LocalId)
            .DefaultIfEmpty(0u)
            .Max();
        var next = Math.Max(floor, highest + 1);
        var cap = isLight ? PluginFlagPredicates.LightLocalFormIdCap : FormID.FullIdMask;
        return next > cap ? null : $"{next:X6}:{allocator.Plugin.Name}";
    }

    // Shared by create and copy as new (plugins.md, Create record, story 3): every branch
    // names both remedies, even where one is moot for this plugin.
    internal static string FormKeySpaceExhaustedMessage(PluginAddress plugin, bool isLight, bool freeAboveTheLightCap)
    {
        const string remedies = "Clear the light flag in the header, or change a record's FormID.";
        if (freeAboveTheLightCap)
        {
            return $"{plugin.Name} has exhausted its ESL FormKey space — every local FormID up to 0xFFF is " +
                "already in use (a light-flagged plugin's addressable range) — but native space remains " +
                $"free above it. {remedies}";
        }
        return isLight
            ? $"{plugin.Name} has exhausted its ESL FormKey space — every local FormID up to 0xFFF is " +
              $"already in use (a light-flagged plugin's addressable range). {remedies}"
            : $"{plugin.Name} has exhausted its FormKey space — every local FormID up to 0xFFFFFF is " +
              $"already in use. {remedies}";
    }

    private static uint LocalId(string formKey) =>
        uint.Parse(formKey[..formKey.IndexOf(':')], NumberStyles.HexNumber, CultureInfo.InvariantCulture);

    /// <summary>The EditorID a written document's own text names, which the put names the unit by.</summary>
    internal static string? EditorIdOf(string text)
    {
        using var document = JsonDocument.Parse(text);
        return document.RootElement.TryGetProperty(RecordMembers.EditorId, out var editorId)
            && editorId.ValueKind == JsonValueKind.String
            ? editorId.GetString()
            : null;
    }

    // The codec's own words are the reason (ADR-0015 invariant 5).
    internal static RecordEditResult RefuseUnreadable(string formKey, string why, string? spelled = null) =>
        new(false, RecordEditRefusal.RecordParseFailed,
            $"{formKey}'s document cannot be read, so nothing can be written to it: {why}", Path: spelled);

    // A tree file named for the record that is no document refuses rather than reading as none.
    private static RecordIdentity? IdentityIn(CopySource source, string formKey) =>
        source.Identity(formKey)
        ?? (source.Tree?.UnreadableDocumentFor(source.Plugin, formKey) is { } why
            ? throw new InvalidDataException($"{source.Plugin.Name}'s document for {formKey} is no record document: {why}")
            : null);

    /// <summary>The nearest copy left of <paramref name="plugin"/>, among <paramref name="among"/> if given,
    /// that <paramref name="says"/> accepts, passing over one whose header holds a flag of
    /// <paramref name="passOver"/>. An unreadable copy ends the walk.</summary>
    internal LeftCopy NearestCopyToTheLeft(
        PluginAddress plugin, string formKey, Func<JsonObject, bool> says, long passOver = 0, IReadOnlySet<string>? among = null) =>
        NearestToTheLeft(plugin, formKey, among, source =>
        {
            if (IdentityIn(source, formKey) is not { } identity) return null;
            if (passOver != 0 && (source.RecordFlags(identity) & passOver) != 0) return null;
            var body = source.Body(identity);
            return JsonNode.Parse(body) is JsonObject copy && says(copy) ? body : null;
        });

    /// <summary>The nearest copy left of <paramref name="plugin"/>, among <paramref name="among"/>, of the
    /// exterior cell at grid (<paramref name="x"/>, <paramref name="y"/>) of <paramref name="worldspace"/>.</summary>
    internal LeftCopy NearestCellToTheLeft(PluginAddress plugin, string worldspace, int x, int y, IReadOnlySet<string> among) =>
        NearestToTheLeft(plugin, worldspace, among, source =>
            source.CellAt(worldspace, x, y) is { } cell && IdentityIn(source, cell) is { } identity ? source.Body(identity) : null);

    // The plugins left of this one, nearest first, until one answers a text. An unreadable one ends the
    // walk, named by what it was asked about.
    private LeftCopy NearestToTheLeft(
        PluginAddress plugin, string askedAbout, IReadOnlySet<string>? among, Func<CopySource, string?> answer)
    {
        var current = loadOrder.Current;
        var index = current.LoadOrderIndex(plugin) ?? current.Active.Count;
        var asked = current.Active.Take(index).Reverse().Select(registered => registered.Key)
            .Where(left => among?.Contains(left.Name) ?? true);
        foreach (var left in asked)
        {
            using var source = new CopySource(left, current, adapter, codec, schemaReflector);
            try
            {
                if (answer(source) is { } text) return new LeftCopy.Found(text);
            }
            catch (Exception ex) when (ex is not OutOfMemoryException)
            {
                return new LeftCopy.Unreadable(left.Name, askedAbout, source.Diagnose(ex));
            }
        }
        return new LeftCopy.None();
    }

    // Refused before any write. Not folded into ResolveEditTarget because Edit reaches the
    // header deliberately. Without it, HoldingUnit.IsDirectoryPerRecord (filename-only) answers true
    // for the header and DeleteRecord deletes the plugin's whole source root.
    internal static RecordEditResult? RefuseIfHeader(string recordType) =>
        recordType == PluginHeader.RecordType
            ? RecordEditResult.Refused(
                RecordEditRefusal.HeaderDeleteNotSupported,
                "The plugin header cannot be deleted — it is not an ordinary record.")
            : null;

    // CreateRecord and CopyAsNewRecord only: a brand-new record has no containment to resolve to, and
    // choosing one is a UX decision.
    internal static RecordEditResult? RefuseIfContainerType(string recordType, GameRelease release)
    {
        if (CreatableRecordTypes.Includes(recordType, release)) return null;

        return RecordEditResult.Refused(
            RecordEditRefusal.ContainerRecordNotYetSupported,
            $"'{recordType}' is a container record — it owns child records of its own (a cell, a " +
            "worldspace, a quest, a dialog topic) — or the game cannot create it (a placed reference, " +
            "a landscape, a navmesh, a dialog branch, a scene or a response, each held inside another " +
            "record's document). Editing its fields and its FormID works, and so does deleting it; " +
            "creating one from scratch is not supported.");
    }
}
