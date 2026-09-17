using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.SourceRepo;

namespace MEditService.Commands.Edits;

/// <summary>What handling "a tracked mod settled" found, for the caller's own logging: whichever
/// question or repair offer it names is already published by the time this returns.</summary>
public enum TrackedModSettledOutcome
{
    NoQuestion,
    QuestionOpened,
    CrashRecovery,
}

/// <summary>The watcher's one verb (ADR-0015): plugins off the load order, classified from the
/// Source repository's facts; a genuine external change opens the mod's one question and
/// publishes it.</summary>
public static class TrackedModSettled
{
    public static TrackedModSettledOutcome Handle(
        LoadOrderSnapshot loadOrder, string modFolder, INotificationPublisher notifications)
    {
        if (ExternalChangeClassifier.PluginBytesIn(loadOrder, modFolder) is not { } plugins)
            return TrackedModSettledOutcome.NoQuestion;

        switch (ExternalChangeClassifier.ClassifyMod(modFolder, plugins))
        {
            case ExternalChangeClassification.ExternalChange change:
                Raise(loadOrder, modFolder, change, notifications);
                return TrackedModSettledOutcome.QuestionOpened;

            case ExternalChangeClassification.CrashRecovery:
                // Never opened or cleared as the external-change question is — the repair offer's
                // own state, and the two prompts must never both fire for one event.
                RaiseCrashRepair(
                    loadOrder, modFolder, [.. plugins.Select(p => p.PluginName)],
                    CrashRepairReason.InterruptedCompile, notifications);
                return TrackedModSettledOutcome.CrashRecovery;

            default:
                SourceRepository.ClearExternalChangeQuestion(modFolder);
                return TrackedModSettledOutcome.NoQuestion;
        }
    }

    /// <summary>The repair offer's own verdict of the same question-open notification kind
    /// (ADR-0009): a tracked binary the load-time check found unreadable, or an interrupted
    /// compile above, each naming the plugins it found.</summary>
    public static void RaiseCrashRepair(
        LoadOrderSnapshot loadOrder, string modFolder, IReadOnlyList<string> plugins, CrashRepairReason reason,
        INotificationPublisher notifications) =>
        notifications.Publish(new QuestionOpenNotification(
            OriginOf(loadOrder, modFolder), plugins, TrackedFiles: [], MetaChanged: false, OldVersion: null,
            NewVersion: null, CrashRepairReason: reason.ToString()));

    private static void Raise(
        LoadOrderSnapshot loadOrder, string modFolder,
        ExternalChangeClassification.ExternalChange change, INotificationPublisher notifications)
    {
        var modName = Path.GetFileName(modFolder.TrimEnd(Path.DirectorySeparatorChar));
        var named = change.Plugins.Concat(change.TrackedFiles).ToList();
        var changed = named.Count > 0 ? string.Join(", ", named) : modName;
        SourceRepository.RaiseExternalChangeQuestion(modFolder,
            $"{changed} (in {modName}) changed outside Modbench and is awaiting an answer — " +
            "Commit to main as new baseline, or Apply to working tree on edit; the question is " +
            "asked again on the next change or load.");

        notifications.Publish(new QuestionOpenNotification(
            OriginOf(loadOrder, modFolder), change.Plugins, change.TrackedFiles,
            change.MetaChanged, change.OldVersion, change.NewVersion));
    }

    // A change's own Plugins list can be empty (a tracked-file-only change), so origin resolves off
    // the mod folder alone.
    private static string OriginOf(LoadOrderSnapshot loadOrder, string modFolder) =>
        loadOrder.Copies.FirstOrDefault(copy => LoadOrderSnapshot.ModFolderOf(copy.Origin, copy.Path) == modFolder)
            ?.Origin ?? "";
}
