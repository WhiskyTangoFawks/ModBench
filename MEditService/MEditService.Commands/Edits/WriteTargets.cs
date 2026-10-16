using System.Text;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Commands.Resolution;
using MEditService.LoadOrder;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Strings;

namespace MEditService.Commands.Edits;

/// <summary>The write side's target gate (target-architecture.d2 medit_core.commands): which plugin and record a gesture may write, and its pre-write refusals.
/// An internal seam, tested through the gestures.</summary>
internal sealed class WriteTargets(
    LoadOrderHolder loadOrder, ISourceAdapter source)
{
    internal readonly record struct EditTarget(GameRelease Release, RecordIdentity Identity, IWriteSession Session)
    {
        internal ISourceRepository Repository => Session.Repository;
    }

    internal RecordEditResult? ResolveEditTarget(PluginAddress plugin, string formKey, WriteSessions sessions, out EditTarget target)
    {
        target = default;
        if (RefuseUnlessEditable(plugin) is { } blocked) return blocked;
        return ResolveInTheTree(plugin, formKey, SessionOf(plugin, sessions), loadOrder.Current.GameRelease, out target, out _);
    }

    private static RecordEditResult RefuseUnresolved(string formKey, SourceFailure failure) =>
        failure is SourceFailure.Unreadable
            ? RefuseUnreadable(formKey, failure.Reason)
            : RecordEditResult.Refused(WriteFailure.KindOf(failure), failure.Reason);

    private static RecordEditResult RecordNotFound(PluginAddress plugin, string formKey) =>
        RecordEditResult.Refused(
            RecordEditRefusal.RecordNotFound,
            $"No document in {plugin.Name}'s source tree holds {formKey}, and no record's document carries it.");

    internal static RecordEditResult? ResolveInTheTree(
        PluginAddress plugin, string formKey, IWriteSession session, GameRelease release, out EditTarget target,
        out SourceDocument? found)
    {
        target = default;
        if (!session.Repository.RecordByFormKey(plugin, formKey).Holds(out found, out var failure)) return RefuseUnresolved(formKey, failure);
        if (found is not { } document) return RecordNotFound(plugin, formKey);

        target = new EditTarget(release, document.Identity, session);
        return null;
    }

    /// <summary>The session over the mod folder of <paramref name="plugin"/>, which is editable.</summary>
    internal IWriteSession SessionOf(PluginAddress plugin, WriteSessions sessions) =>
        sessions.Over(
            loadOrder.Current.Plugin(plugin)?.Provider as PluginProvider.FromMod
                ?? throw new InvalidOperationException($"Expected {plugin.Name}, once editable, to be provided by a mod."),
            loadOrder.Current.GameRelease);

    internal readonly record struct CopyTarget(
        CopySource Source, RecordIdentity Identity, RecordCopy.Destination Destination, GameRelease Release, string Body);

    // Asymmetric by construction: the write-path gate checks the destination, the source answers for
    // its own record. The text is read before anything is written, because a record the codec cannot
    // read would land as a stub.
    internal RecordEditResult? ResolveCopySource(
        PluginAddress destinationPlugin, CopySource source, string formKey, WriteSessions sessions, out CopyTarget target)
    {
        target = default;

        if (RefuseUnlessEditable(destinationPlugin) is { } blocked) return blocked;

        if (!source.Identity(formKey).Holds(out var held, out var why)) return RefuseUnreadableCopySource(formKey, why);
        if (held is not { } identity)
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.RecordNotFound, $"{source.Plugin.Name} does not hold record {formKey}.");
        }
        if (!source.Body(identity).Holds(out var body, out why)) return RefuseUnreadableCopySource(formKey, why);

        var session = SessionOf(destinationPlugin, sessions);
        var release = loadOrder.Current.GameRelease;
        if (!NotLocalizedIn(session.Repository, destinationPlugin, release).Holds(out var language, out var unreadable))
            return RefuseUnreadable(formKey, unreadable.Reason);
        var destination = new RecordCopy.Destination(session, destinationPlugin, language);
        target = new CopyTarget(source, identity, destination, release, destination.Landing(body, release, identity.RecordType));
        return null;
    }

    private Answer<Language?, SourceFailure> NotLocalizedIn(ISourceRepository repository, PluginAddress plugin, GameRelease release) =>
        repository.RecordOf(plugin, PluginHeader.IdentityOf(plugin.Name)).Then(header =>
            SourceAnswer.Of(
                header is { } held && !HeaderDocument.IsLocalized(Encoding.UTF8.GetBytes(held.Body), release)
                    ? (Language?)loadOrder.Current.StringsLanguage
                    : null));

    // A record's own descendants are inside its text, so one unreadable response refuses its topic
    // here too.
    private static RecordEditResult RefuseUnreadableCopySource(string formKey, CopyUnread unread) =>
        unread.Kind == RecordEditRefusal.RecordParseFailed
            ? RecordEditResult.Refused(
                RecordEditRefusal.RecordParseFailed,
                $"{formKey} cannot be read, so copying it would land a stub holding only its FormKey and " +
                $"EditorID rather than the record: {unread.Why}")
            : RefuseUnreadableSource(formKey, unread);

    /// <summary>A copy that reads its source beyond its own record, as an exterior cell's worldspace,
    /// refuses naming what it could not read.</summary>
    internal static RecordEditResult RefuseUnreadableSource(string formKey, CopyUnread unread) =>
        RecordEditResult.Refused(unread.Kind, $"{formKey} cannot be copied: {unread.Why} Nothing was written.");

    // The six record gestures enter here first.
    internal RecordEditResult? RefuseUnlessEditable(PluginAddress plugin)
    {
        if (loadOrder.Current.Plugin(plugin) is not { } registered)
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.PluginNotInLoadOrder,
                $"{plugin.Name} from '{plugin.Origin}' is not in the load order, so nothing can be written to it.");
        }

        if (!source.IsSourceMod(registered)) return RefuseNonCompiledPlugin(plugin, registered.Provider);
        return source.SourceReads(registered) ? null : RefuseSourceUnreadable(plugin);
    }

    // Two refusals, because there are two different ways out and a message that named neither
    // would be silent dead UI.
    private static RecordEditResult RefuseNonCompiledPlugin(PluginAddress plugin, PluginProvider provider) =>
        provider is not PluginProvider.FromMod
            ? RecordEditResult.Refused(RecordEditRefusal.PluginHasNoModFolder, NoModFolderMessage(plugin, provider))
            : RecordEditResult.Refused(
                RecordEditRefusal.PluginNotCompiledPlugin,
                $"{plugin.Name} is not a compiled plugin, so it is read-only. " +
                "Decompile and commit its mod once to start editing.");

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
            : $"{plugin.Name} is a base-game plugin with no mod folder, so it cannot be a compiled plugin. " +
              "Author a patch plugin and edit the override there.";

    // The codec's own words are the reason (ADR-0015).
    internal static RecordEditResult RefuseUnreadable(string formKey, string why, string? spelled = null) =>
        new(false, RecordEditRefusal.RecordParseFailed,
            $"{formKey}'s document cannot be read, so nothing can be written to it: {why}", Path: spelled);
}
