using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.SourceRepo;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Edits;

/// <summary>The handler seam behind "a tracked mod settled" (ADR-0015): one call, classifying from
/// the Source repository's own facts, whether it is asked at a restart or from a live change.</summary>
public sealed class TrackedModSettledTests : IDisposable
{
    private readonly InMemoryNotificationPublisher _notifications = new();
    private readonly SourceEditFixture _mod = SourceEditFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private static void WriteExternalBinaryChange(SourceEditFixture mod, float newHeightMax)
    {
        var externalMod = new Fallout4Mod(ModKey.FromFileName(SourceEditFixture.PluginName), Fallout4Release.Fallout4);
        var race = externalMod.Races.AddNew("FixtureRace");
        externalMod.Keywords.AddNew("FixtureKeyword");
        var npc = externalMod.Npcs.AddNew("FixtureNpc");
        npc.Race.SetTo(race);
        npc.HeightMax = newHeightMax;
        externalMod.Npcs.AddNew("UntouchedNpc");
        externalMod.WriteToBinary(Path.Combine(mod.ModFolder, SourceEditFixture.PluginName));
    }

    [Fact]
    public void Handle_OpensTheQuestion_AndPublishesIt_ForAGenuineExternalChange()
    {
        WriteExternalBinaryChange(_mod, 0.9f);

        var outcome = TrackedModSettled.Handle(_mod.LoadOrder, _mod.ModFolder, _notifications);

        Assert.Equal(TrackedModSettledOutcome.QuestionOpened, outcome);
        var question = SourceRepository.UnansweredExternalChange(_mod.ModFolder);
        Assert.NotNull(question);
        Assert.Contains(SourceEditFixture.PluginName, question, StringComparison.Ordinal);
        var pending = Assert.Single(_notifications.Notifications.OfType<QuestionOpenNotification>());
        Assert.Equal(SourceEditFixture.ModFolderOrigin, pending.Origin);
        Assert.Equal([SourceEditFixture.PluginName], pending.Plugins);
    }

    [Fact]
    public void Handle_ClearsTheQuestion_AndPublishesNothing_WhenNothingChanged()
    {
        SourceRepository.RaiseExternalChangeQuestion(_mod.ModFolder, "a question whose change is gone");

        var outcome = TrackedModSettled.Handle(_mod.LoadOrder, _mod.ModFolder, _notifications);

        Assert.Equal(TrackedModSettledOutcome.NoQuestion, outcome);
        Assert.Null(SourceRepository.UnansweredExternalChange(_mod.ModFolder));
        Assert.Empty(_notifications.Notifications);
    }

    [Fact]
    public void Handle_LeavesTheMarkerAlone_WhenAPluginCannotBeRead()
    {
        SourceRepository.RaiseExternalChangeQuestion(_mod.ModFolder, "a question the binary cannot answer for now");
        File.Delete(Path.Combine(_mod.ModFolder, SourceEditFixture.PluginName));

        var outcome = TrackedModSettled.Handle(_mod.LoadOrder, _mod.ModFolder, _notifications);

        Assert.Equal(TrackedModSettledOutcome.NoQuestion, outcome);
        Assert.NotNull(SourceRepository.UnansweredExternalChange(_mod.ModFolder));
        Assert.Empty(_notifications.Notifications);
    }

    // The two prompts must never both fire for one event: a crash recovery verdict is the repair
    // offer's own state, so a question already open stands exactly as it was.
    [Fact]
    public void Handle_ReturnsCrashRecovery_AndTouchesNoMarker_ForAnInterruptedCompile()
    {
        SourceRepository.RaiseExternalChangeQuestion(_mod.ModFolder, "a question already open before the crash");
        Assert.ThrowsAny<Exception>(() =>
            CompileJournal.RunBatch(_mod.ModFolder, [SourceEditFixture.PluginName],
                _ => throw new InvalidOperationException("simulated crash between source and binary write")));
        Assert.NotNull(CompileJournal.UnfinishedBatch(_mod.ModFolder)); // sanity: the marker really is there.

        var outcome = TrackedModSettled.Handle(_mod.LoadOrder, _mod.ModFolder, _notifications);

        Assert.Equal(TrackedModSettledOutcome.CrashRecovery, outcome);
        Assert.Equal("a question already open before the crash", SourceRepository.UnansweredExternalChange(_mod.ModFolder));
        // Assert.Single is also "never both": the repair offer and the external-change dialog's
        // own question must never fire together for one event.
        var pending = Assert.Single(_notifications.Notifications.OfType<QuestionOpenNotification>());
        Assert.Equal(SourceEditFixture.ModFolderOrigin, pending.Origin);
        Assert.Equal([SourceEditFixture.PluginName], pending.Plugins);
        Assert.Equal(nameof(CrashRepairReason.InterruptedCompile), pending.CrashRepairReason);
    }

    // The rival this pins: naming the mod from the load-order copy that raised the question,
    // which reads as "(in )" the moment a tracked-file-only change has no copy left to name it.
    [Fact]
    public void Handle_NamesTheModByItsFolder_ForATrackedFileOnlyChange_WithNoLoadOrderCopy()
    {
        using var mod = SourceEditFixture.TrackedEverything(
            folder => File.WriteAllText(Path.Combine(folder, "texture.dds"), "original"));
        File.WriteAllText(Path.Combine(mod.ModFolder, "texture.dds"), "changed-by-the-release");
        var noCopies = new LoadOrderSnapshot(mod.GameDirectory, mod.InstanceRoot, GameRelease.Fallout4, []);

        var outcome = TrackedModSettled.Handle(noCopies, mod.ModFolder, _notifications);

        Assert.Equal(TrackedModSettledOutcome.QuestionOpened, outcome);
        var question = SourceRepository.UnansweredExternalChange(mod.ModFolder);
        Assert.NotNull(question);
        Assert.Contains($"in {SourceEditFixture.ModFolderOrigin}", question, StringComparison.Ordinal);
    }

    // The rival this pins: a second call site re-deriving its own verdict, which would let a
    // restart and a change disagree over what one call already answered identically.
    [Fact]
    public void ASecondCall_OverTheSameFacts_ProducesTheIdenticalQuestion()
    {
        WriteExternalBinaryChange(_mod, 0.9f);

        var first = TrackedModSettled.Handle(_mod.LoadOrder, _mod.ModFolder, _notifications);
        var firstNotification = Assert.Single(_notifications.Notifications.OfType<QuestionOpenNotification>());
        var second = TrackedModSettled.Handle(_mod.LoadOrder, _mod.ModFolder, _notifications);
        var secondNotification = Assert.Single(_notifications.Notifications.OfType<QuestionOpenNotification>().Skip(1));

        Assert.Equal(first, second);
        Assert.Equal(firstNotification.Origin, secondNotification.Origin);
        Assert.Equal(firstNotification.Plugins, secondNotification.Plugins);
        Assert.Equal(firstNotification.TrackedFiles, secondNotification.TrackedFiles);
        Assert.Equal(firstNotification.MetaChanged, secondNotification.MetaChanged);
        Assert.Equal(firstNotification.OldVersion, secondNotification.OldVersion);
        Assert.Equal(firstNotification.NewVersion, secondNotification.NewVersion);
    }
}
