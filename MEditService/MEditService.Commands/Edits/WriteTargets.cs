using System.Diagnostics.CodeAnalysis;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Commands.Resolution;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using Mutagen.Bethesda;

namespace MEditService.Commands.Edits;

/// <summary>The write side's target gate (target-architecture.d2 medit_core.commands): which plugin and record a gesture may write, and its pre-write refusals.
/// An internal seam, tested through the gestures.</summary>
internal sealed class WriteTargets(
    LoadOrderHolder loadOrder,
    SchemaReflector schemaReflector)
{
    internal readonly record struct EditTarget(GameRelease Release, RecordIdentity Identity, SourceRepository Repository);

    // The working tree is the only thing asked (ADR-0015), so a second edit builds on
    // the first. The copy gestures read the source instead.
    internal RecordEditResult? ResolveEditTarget(PluginAddress plugin, string formKey, out EditTarget target) =>
        TryResolveEditTarget(plugin, formKey, out target, out _, out var refused) ? null : refused;

    /// <summary>The edit target and the record's own text in one read of the tree.</summary>
    internal bool TryResolveEditTarget(
        PluginAddress plugin, string formKey, out EditTarget target,
        [NotNullWhen(true)] out SourceDocument? document, [NotNullWhen(false)] out RecordEditResult? refused)
    {
        (target, document) = (default, null);

        refused = RefuseUnlessEditable(plugin, out var openedRepository);
        if (refused is not null) return false;
        var repository = openedRepository
            ?? throw new InvalidOperationException("Expected RefuseUnlessEditable to open a repository when it does not refuse.");

        var release = loadOrder.Current.GameRelease;
        try
        {
            refused = ResolveInTheTree(plugin, formKey, repository, release, out target, out document);
        }
        catch (AmbiguousSourceUnitException ex)
        {
            refused = RecordEditResult.Refused(RecordEditRefusal.AmbiguousSourceUnit, ex.Message);
        }
        return refused is null && document is not null;
    }

    /// <summary>The edit target with <paramref name="text"/> standing in for the file of the document carrying
    /// the record: the tree only says which document that is.</summary>
    internal bool TryResolveEditTarget(
        PluginAddress plugin, string formKey, string text, out EditTarget target,
        [NotNullWhen(true)] out SourceDocument? carrying, [NotNullWhen(false)] out RecordEditResult? refused)
    {
        (target, carrying) = (default, null);
        refused = RefuseUnlessEditable(plugin, out var openedRepository);
        if (refused is not null) return false;
        var repository = openedRepository
            ?? throw new InvalidOperationException("Expected RefuseUnlessEditable to open a repository when it does not refuse.");

        var release = loadOrder.Current.GameRelease;
        try
        {
            if (repository.CarryingFromText(plugin, formKey, text, schemaReflector.GetSchemas(release)) is not var (record, document))
            {
                refused = RecordNotFound(plugin, formKey);
                return false;
            }
            (target, carrying) = (new EditTarget(release, record, repository), document);
            return true;
        }
        catch (AmbiguousSourceUnitException ex)
        {
            refused = RecordEditResult.Refused(RecordEditRefusal.AmbiguousSourceUnit, ex.Message);
        }
        catch (UnreadableSourceDocumentException ex)
        {
            refused = RefuseUnreadable(formKey, ex.Message);
        }
        return false;
    }

    private static RecordEditResult RecordNotFound(PluginAddress plugin, string formKey) =>
        RecordEditResult.Refused(
            RecordEditRefusal.RecordNotFound,
            $"No document in {plugin.Name}'s source tree holds {formKey}, and no record's document carries it.");

    private RecordEditResult? ResolveInTheTree(
        PluginAddress plugin, string formKey, SourceRepository repository, GameRelease release, out EditTarget target,
        out SourceDocument? found)
    {
        target = default;
        found = null;
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

        if (found is not { } document) return RecordNotFound(plugin, formKey);

        target = new EditTarget(release, document.Identity, repository);
        return null;
    }

    internal readonly record struct CopyTarget(
        CopySource Source, RecordIdentity Identity, RecordCopy.Destination Destination, GameRelease Release, string Body);

    // Asymmetric by construction: the write-path gate checks the destination, the source answers for
    // its own record. The text is read before anything is written, because a record the codec cannot
    // read would land as a stub.
    internal RecordEditResult? ResolveCopySource(
        PluginAddress destinationPlugin, CopySource source, string formKey, out CopyTarget target)
    {
        target = default;

        if (RefuseUnlessEditable(destinationPlugin, out var openedDestinationRepository)
            is { } blocked) return blocked;
        var destinationRepository = openedDestinationRepository
            ?? throw new InvalidOperationException("Expected RefuseUnlessEditable to open a repository when it does not refuse.");

        try
        {
            if (source.Identity(formKey) is not { } identity)
            {
                return RecordEditResult.Refused(
                    RecordEditRefusal.RecordNotFound, $"{source.Plugin.Name} does not hold record {formKey}.");
            }

            target = new CopyTarget(
                source, identity,
                new RecordCopy.Destination(destinationRepository, destinationPlugin),
                loadOrder.Current.GameRelease, source.Body(identity));
            return null;
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
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

    /// <summary>A copy that reads a source-tree document beyond its own record, as an exterior cell's
    /// worldspace, refuses naming that document.</summary>
    internal static RecordEditResult RefuseUnreadableSourceTree(string formKey, string why) =>
        RecordEditResult.Refused(RecordEditRefusal.RecordParseFailed, $"{formKey} cannot be copied: {why} Nothing was written.");

    // The six record gestures enter here first.
    internal RecordEditResult? RefuseUnlessEditable(PluginAddress plugin, out SourceRepository? repository)
    {
        repository = null;

        if (loadOrder.Current.Plugin(plugin) is not { } registered)
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.PluginNotInLoadOrder,
                $"{plugin.Name} from '{plugin.Origin}' is not in the load order, so nothing can be written to it.");
        }

        if (registered.Provider is not PluginProvider.FromMod mod || !SourceRepository.IsTracked(registered))
            return RefuseUntracked(plugin, registered.Provider);

        if (!SourceRepository.SourceReads(registered)) return RefuseSourceUnreadable(plugin);

        repository = SourceRepository.Over(mod, loadOrder.Current.GameRelease);
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
                "Track its mod once to start editing.");

    private static RecordEditResult RefuseSourceUnreadable(PluginAddress plugin) =>
        RecordEditResult.Refused(
            RecordEditRefusal.PluginSourceUnreadable,
            $"{plugin.Name}'s plugin source is unreadable, so it is read-only. " +
            "Decompile the plugin to regenerate the source.");

    // Neither origin's way out is the other's.
    private static string NoModFolderMessage(PluginAddress plugin, PluginProvider provider) =>
        provider == PluginProvider.NoMod
            ? $"{plugin.Name} is loaded from Overwrite, an origin and not a mod, so it has no mod " +
              "folder to hold its source. Move it into a mod, then edit it there."
            : $"{plugin.Name} is a base-game plugin with no mod folder, so it cannot be tracked. " +
              "Author a patch plugin and edit the override there.";

    // The codec's own words are the reason (ADR-0015).
    internal static RecordEditResult RefuseUnreadable(string formKey, string why, string? spelled = null) =>
        new(false, RecordEditRefusal.RecordParseFailed,
            $"{formKey}'s document cannot be read, so nothing can be written to it: {why}", Path: spelled);
}
