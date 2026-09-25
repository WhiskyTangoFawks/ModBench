using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.SourceAdapter;

namespace MEditService.Commands.Edits;

/// <summary>What handling "a tracked mod settled" found, for the caller's own logging: whichever
/// question or warning it names is already published by the time this returns.</summary>
public enum TrackedModSettledOutcome
{
    NoQuestion,
    QuestionOpened,
    CompileUnfinished,
}

/// <summary>What the watcher calls when a tracked mod settles (ADR-0015 invariant 2): plugins off
/// the load order, classified from the Source repository's facts; a genuine external change opens
/// the mod's one question and publishes it.</summary>
public sealed class TrackedModSettled
{
    private readonly INotificationPublisher _notifications;

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every handler.
    internal TrackedModSettled(INotificationPublisher notifications) => _notifications = notifications;

    /// <summary>Reads every plugin the load order holds in the mod off disk, then classifies. A
    /// plugin caught mid-write is no verdict.</summary>
    public TrackedModSettledOutcome Handle(LoadOrderSnapshot loadOrder, string modFolder) =>
        ExternalChangeClassifier.PluginBytesIn(loadOrder, modFolder) is { } plugins
            ? Handle(loadOrder, modFolder, plugins)
            : TrackedModSettledOutcome.NoQuestion;

    /// <summary>Classifies from bytes the caller already read, so a load-time readability probe and
    /// the settle share one read of each tracked binary.</summary>
    public TrackedModSettledOutcome Handle(
        LoadOrderSnapshot loadOrder, string modFolder, IReadOnlyList<(string PluginName, byte[] ObservedBytes)> plugins)
    {
        switch (ExternalChangeClassifier.ClassifyMod(modFolder, plugins))
        {
            case ExternalChangeClassification.ExternalChange change:
                Raise(loadOrder, modFolder, change);
                return TrackedModSettledOutcome.QuestionOpened;

            case ExternalChangeClassification.CompileUnfinished unfinished:
                return Warn(loadOrder, modFolder, unfinished);

            // The compile that is writing the bytes settles the mod again when it lands.
            case ExternalChangeClassification.CompileRunning:
                return TrackedModSettledOutcome.NoQuestion;

            default:
                SourceRepository.ClearExternalChangeQuestion(modFolder);
                return TrackedModSettledOutcome.NoQuestion;
        }
    }

    /// <summary>A tracked binary the caller could not read is no verdict: the question is neither
    /// opened nor cleared, and an interrupted compile's mark is still published.</summary>
    public TrackedModSettledOutcome HandleUnreadable(LoadOrderSnapshot loadOrder, string modFolder) =>
        ExternalChangeClassifier.UnfinishedCompile(modFolder) is { } unfinished
            ? Warn(loadOrder, modFolder, unfinished)
            : TrackedModSettledOutcome.NoQuestion;

    // compile-plugin, Failure: no question opens.
    private TrackedModSettledOutcome Warn(
        LoadOrderSnapshot loadOrder, string modFolder, ExternalChangeClassification.CompileUnfinished unfinished)
    {
        var origin = OriginOf(loadOrder, modFolder);
        foreach (var plugin in unfinished.Plugins)
            _notifications.Publish(new CompileUnfinishedNotification(new PluginAddress(plugin, origin)));
        return TrackedModSettledOutcome.CompileUnfinished;
    }

    private void Raise(LoadOrderSnapshot loadOrder, string modFolder, ExternalChangeClassification.ExternalChange change)
    {
        var modName = SourceRepository.ModNameIn(modFolder);
        var named = change.Plugins.Concat(change.TrackedFiles).ToList();
        var changed = named.Count > 0 ? string.Join(", ", named) : modName;
        SourceRepository.RaiseExternalChangeQuestion(modFolder,
            $"{changed} (in {modName}) changed outside Modbench and is awaiting an answer — " +
            "Commit to main as new baseline, or Apply to working tree on edit; the question is " +
            "asked again on the next change or load.");

        _notifications.Publish(new QuestionOpenNotification(
            OriginOf(loadOrder, modFolder), change.Plugins, change.TrackedFiles,
            change.MetaChanged, change.OldVersion, change.NewVersion));
    }

    // A change's own Plugins list can be empty (a tracked-file-only change), so origin resolves off
    // the mod folder alone.
    private static string OriginOf(LoadOrderSnapshot loadOrder, string modFolder) =>
        loadOrder.Plugins.FirstOrDefault(plugin => LoadOrderSnapshot.ModFolderOf(plugin.Origin, plugin.Path) == modFolder)
            ?.Origin ?? "";
}
