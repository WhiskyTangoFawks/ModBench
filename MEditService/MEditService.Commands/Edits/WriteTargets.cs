using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.SourceAdapter;
using Mutagen.Bethesda;

namespace MEditService.Commands.Edits;

/// <summary>The write side's shared concerns (target-architecture.d2 medit_core.commands): target resolution and its pre-write refusals.
/// An internal seam, tested through the gestures.</summary>
internal sealed class WriteTargets(
    LoadOrderHolder loadOrder,
    IPluginAdapter adapter,
    RecordTextCodec codec,
    SchemaReflector schemaReflector)
{
    /// <summary>The palette title verbatim (package.json's "Track…" under category "Modbench"); a signpost
    /// naming a command the user cannot find is worse than none.</summary>
    internal const string TrackCommandTitle = "Modbench: Track Mod\u2026";

    internal readonly record struct EditTarget(GameRelease Release, RecordIdentity Identity, SourceRepository Repository);

    // The working tree is the only thing asked (ADR-0015), so a second edit builds on
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
        SourceDocument? found;
        try
        {
            found = repository.Get(plugin, formKey, schemaReflector.GetSchemas(release));
        }
        catch (Exception ex) when (ex is not (OutOfMemoryException or AmbiguousSourceUnitException))
        {
            // Naming this record means reading the document that carries it: the reader's own words
            // are the reason. A document named for the record whose text is not one is not absence.
            return RefuseUnreadable(formKey, ex.Message);
        }

        if (found is not { } document)
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.RecordNotFound,
                $"No document in {plugin.Name}'s source tree holds {formKey}, and no record's document " +
                "carries it.");
        }

        target = new EditTarget(release, document.Identity, repository);
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
            if (source.Identity(formKey) is not { } identity)
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

    /// <summary>The masters <paramref name="plugin"/>'s source tree requires, or the refusal of a tree that
    /// cannot be read.</summary>
    internal static RecordEditResult? MastersOf(
        SourceRepository repository, PluginAddress plugin, IReadOnlyDictionary<string, RecordTableSchema> schemas,
        string spelled, string readFromAMaster, out IReadOnlySet<string> masters)
    {
        masters = new HashSet<string>();
        try
        {
            masters = RequiredMasters.InTheTree(repository, plugin, schemas);
            return null;
        }
        catch (UnreadableSourceDocumentException ex)
        {
            return RecordEditResult.RefusedAt(
                RecordEditRefusal.RecordParseFailed, spelled,
                $"'{spelled}': {readFromAMaster} comes only from a master of {plugin.Name}, " +
                $"which its source tree names, and that tree cannot be read: {ex.Message.TrimEnd('.')}. Nothing was written.");
        }
    }

    // The six record gestures enter here first.
    internal RecordEditResult? RefuseUnlessTrackedAndLoaded(PluginAddress plugin, out SourceRepository? repository)
    {
        repository = null;

        if (loadOrder.Current.ProviderOf(plugin) is not { } provider)
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.PluginNotInLoadOrder,
                $"{plugin.Name} from '{plugin.Origin}' is not in the load order, so nothing can be written to it.");
        }

        if (provider is not PluginProvider.FromMod mod) return RefuseUntracked(plugin, provider);
        if (SourceRepository.Open(mod, loadOrder.Current.GameRelease) is not { } opened) return RefuseUntracked(plugin, provider);

        repository = opened;
        return RefuseIfNotLoaded(plugin);
    }

    // Tracking is per mod folder and implies neither that the plugin is active nor that it is not.
    private RecordEditResult? RefuseIfNotLoaded(PluginAddress plugin) =>
        loadOrder.Current.IsActive(plugin)
            ? null
            : RecordEditResult.Refused(
                RecordEditRefusal.PluginNotActive,
                $"{plugin.Name} ({plugin.Origin}) is not active, so the game does not load it and it is " +
                "read-only. Enabling its line, or moving its mod toward the winning end, makes it active.");

    // Two refusals, because there are two different ways out and a message that named neither
    // would be silent dead UI.
    private static RecordEditResult RefuseUntracked(PluginAddress plugin, PluginProvider provider) =>
        provider is not PluginProvider.FromMod
            ? RecordEditResult.Refused(RecordEditRefusal.PluginHasNoModFolder, NoModFolderMessage(plugin, provider))
            : RecordEditResult.Refused(
                RecordEditRefusal.PluginNotTracked,
                $"{plugin.Name} is not tracked, so it is read-only. " +
                // The palette entry verbatim; naming a command that does not exist is its own dead end.
                $"Run \"{TrackCommandTitle}\" on it once to start editing.");

    // Neither origin's way out is the other's.
    private static string NoModFolderMessage(PluginAddress plugin, PluginProvider provider) =>
        provider == PluginProvider.NoMod
            ? $"{plugin.Name} is loaded from Overwrite, an origin and not a mod, so it has no mod " +
              "folder to hold its source. Move it into a mod, then edit it there."
            : $"{plugin.Name} is a base-game plugin with no mod folder, so it cannot be tracked. " +
              "Author a patch plugin and edit the override there.";

    /// <summary>The EditorID a written document's own text names, which the put names the unit by.</summary>
    internal static string? EditorIdOf(string text)
    {
        using var document = JsonDocument.Parse(text);
        return document.RootElement.TryGetProperty(RecordMembers.EditorId, out var editorId)
            && editorId.ValueKind == JsonValueKind.String
            ? editorId.GetString()
            : null;
    }

    // The codec's own words are the reason (ADR-0015).
    internal static RecordEditResult RefuseUnreadable(string formKey, string why, string? spelled = null) =>
        new(false, RecordEditRefusal.RecordParseFailed,
            $"{formKey}'s document cannot be read, so nothing can be written to it: {why}", Path: spelled);

    /// <summary>The nearest copy left of <paramref name="plugin"/>, among <paramref name="among"/> if given,
    /// that <paramref name="says"/> accepts, passing over one whose header holds a flag of
    /// <paramref name="passOver"/>. An unreadable copy ends the walk.</summary>
    internal LeftCopy NearestCopyToTheLeft(
        PluginAddress plugin, string formKey, Func<JsonObject, bool> says, long passOver = 0, IReadOnlySet<string>? among = null) =>
        NearestToTheLeft(plugin, formKey, among, source =>
        {
            if (source.Identity(formKey) is not { } identity) return null;
            if (passOver != 0 && (source.RecordFlags(identity) & passOver) != 0) return null;
            var body = source.Body(identity);
            return JsonNode.Parse(body) is JsonObject copy && says(copy) ? body : null;
        });

    /// <summary>The nearest copy left of <paramref name="plugin"/>, among <paramref name="among"/>, of the
    /// exterior cell at grid (<paramref name="x"/>, <paramref name="y"/>) of <paramref name="worldspace"/>.</summary>
    internal LeftCopy NearestCellToTheLeft(PluginAddress plugin, string worldspace, int x, int y, IReadOnlySet<string> among) =>
        NearestToTheLeft(plugin, worldspace, among, source =>
            source.CellAt(worldspace, x, y) is { } identity ? source.Body(identity) : null);

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
    // header deliberately. Without it, the adapter's filename-only container test answers true
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
