using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Tests.Source;

/// <summary>An update of a tracked mod with two plugins and an asset, answered with a new baseline
/// on main (decompile-plugin, The command, step 5, and Failure).</summary>
public sealed class AbsorbUpdatePerPluginTests : IDisposable
{
    private const string Origin = "UpdatedMod";
    private const string First = "First.esp";
    private const string Second = "Second.esp";
    private const string Asset = "Textures/Thing.dds";

    private readonly string _instanceRoot = Directory.CreateTempSubdirectory("medit-absorb-update-").FullName;
    private readonly string _modFolder;
    private readonly LoadOrderSnapshot _loadOrder;
    private readonly AbsorbExternalChangeHandler _absorb;
    private readonly InMemoryNotificationPublisher _notifications = new();

    public AbsorbUpdatePerPluginTests()
    {
        _modFolder = Directory.CreateDirectory(Path.Combine(_instanceRoot, "mods", Origin)).FullName;
        Directory.CreateDirectory(Path.Combine(_modFolder, "Textures"));
        File.WriteAllText(Path.Combine(_modFolder, Asset), "old pixels");
        WritePlugin(First, heightMax: 1.0f);
        WritePlugin(Second, heightMax: 1.0f);

        _loadOrder = new LoadOrderSnapshot(_instanceRoot, _instanceRoot, GameRelease.Fallout4,
        [
            new RegisteredPlugin(First, Origin, Path.Combine(_modFolder, First), 0, Enabled: true, Winning: true),
            new RegisteredPlugin(Second, Origin, Path.Combine(_modFolder, Second), 1, Enabled: true, Winning: true),
        ]);
        new TrackService(NullLogger<TrackService>.Instance, TestAdapters.Mutagen())
            .TrackModAsync(_loadOrder, Origin, SourcePreset.Everything)
            .GetAwaiter().GetResult();

        var holder = new LoadOrderHolder();
        holder.Apply(_loadOrder);
        _absorb = TestEditService.AbsorbHandler(holder);
    }

    public void Dispose()
    {
        try { Directory.Delete(_instanceRoot, recursive: true); }
        catch (IOException) { /* scratch directory, best effort */ }
        catch (UnauthorizedAccessException) { /* ditto */ }
    }

    [Fact]
    public async Task Absorb_OfTwoChangedPluginsAndAChangedAsset_CommitsEachPlugin_ThenTheRest()
    {
        var mainBefore = Git("rev-parse", "refs/heads/main").Trim();
        WritePlugin(First, heightMax: 2.0f);
        WritePlugin(Second, heightMax: 2.0f);
        File.WriteAllText(Path.Combine(_modFolder, Asset), "new pixels");

        var result = await Absorb();

        Assert.True(result.AllApplied);
        Assert.Equal([new PluginAddress(First, Origin), new PluginAddress(Second, Origin)], result.Landed);
        Assert.Equal([$"Update {First}", $"Update {Second}", $"Update {Origin}"], SubjectsOnMainSince(mainBefore));
        Assert.Equal([Asset], PathsIn("refs/heads/main"));
    }

    [Fact]
    public async Task Absorb_CommitsOnlyThePluginsThatChanged_AndLeavesAnUnchangedPluginsParkedRefAlone()
    {
        var mainBefore = Git("rev-parse", "refs/heads/main").Trim();
        var firstParkedBefore = Git("rev-parse", SourceRepository.LastCompileRef(First)).Trim();
        WritePlugin(Second, heightMax: 2.0f);

        var result = await Absorb();

        Assert.Equal([new PluginAddress(Second, Origin)], result.Landed);
        Assert.Equal([$"Update {Second}"], SubjectsOnMainSince(mainBefore));
        Assert.Equal(firstParkedBefore, Git("rev-parse", SourceRepository.LastCompileRef(First)).Trim());
    }

    [Fact]
    public async Task Absorb_WhenTheSecondPluginsCommitFails_KeepsTheFirst_AndLeavesTheQuestionOpenForTheRest()
    {
        var mainBefore = Git("rev-parse", "refs/heads/main").Trim();
        ChangeBothPluginsAndTheAsset();
        SourceRepository.RaiseExternalChangeQuestion(_modFolder, "unanswered");
        RefMoveHook.RefuseMainMovesNaming(_modFolder, Second);

        await Absorb();

        Assert.Equal([$"Update {First}"], SubjectsOnMainSince(mainBefore));
        Assert.NotNull(SourceRepository.UnansweredExternalChange(_modFolder));
        var question = Settle();
        Assert.Equal([Second], question.Plugins);
        Assert.Equal([Asset], question.TrackedFiles);
    }

    [Fact]
    public async Task Absorb_WhenTheSecondPluginsCommitFails_AnswersTheFirstApplied_AndTheSecondRefusedNamingItsCommit()
    {
        ChangeBothPluginsAndTheAsset();
        RefMoveHook.RefuseMainMovesNaming(_modFolder, Second);

        var result = await Absorb();

        Assert.Equal([new PluginAddress(First, Origin)], result.Landed);
        var refused = Assert.Single(result.Refused);
        Assert.Equal((new PluginAddress(Second, Origin), TrackRefusal.CommitFailed), (refused.Plugin, refused.Refusal));
        Assert.Contains($"'Update {Second}' could not be committed to main", refused.Message, StringComparison.Ordinal);
        Assert.Contains($"'Update {Second}'", result.TrackedFilesRefusal, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Absorb_WhenTheFirstPluginsCommitFails_RefusesThePluginItNeverReached_NamingTheCommitThatStoppedIt()
    {
        ChangeBothPluginsAndTheAsset();
        RefMoveHook.RefuseMainMovesNaming(_modFolder, First);

        var result = await Absorb();

        Assert.Empty(result.Landed);
        Assert.Equal(
            [(new PluginAddress(First, Origin), TrackRefusal.CommitFailed), (new PluginAddress(Second, Origin), TrackRefusal.StoppedByEarlierFailure)],
            result.Refused.Select(r => (r.Plugin, r.Refusal)));
        Assert.Contains($"'Update {First}'", result.Refused[1].Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Absorb_WhenTheTrackedFilesCommitFails_AnswersEveryPluginApplied_AndTheTrackedFilesRefused()
    {
        var mainBefore = Git("rev-parse", "refs/heads/main").Trim();
        ChangeBothPluginsAndTheAsset();
        RefMoveHook.RefuseMainMovesNaming(_modFolder, Origin);

        var result = await Absorb();

        Assert.Equal([new PluginAddress(First, Origin), new PluginAddress(Second, Origin)], result.Landed);
        Assert.Empty(result.Refused);
        Assert.Contains($"'Update {Origin}' could not be committed to main", result.TrackedFilesRefusal, StringComparison.Ordinal);
        Assert.False(result.AllApplied);
        Assert.Equal([$"Update {First}", $"Update {Second}"], SubjectsOnMainSince(mainBefore));
    }

    [Fact]
    public async Task Absorb_AnsweredAgainAfterAFailedCommit_CommitsWhatIsLeft_AndEndsTheQuestion()
    {
        var mainBefore = Git("rev-parse", "refs/heads/main").Trim();
        ChangeBothPluginsAndTheAsset();
        RefMoveHook.RefuseMainMovesNaming(_modFolder, Second);
        await Absorb();
        RefMoveHook.Remove(_modFolder);

        var result = await Absorb();

        Assert.Equal([new PluginAddress(Second, Origin)], result.Landed);
        Assert.True(result.AllApplied);
        Assert.Equal([$"Update {First}", $"Update {Second}", $"Update {Origin}"], SubjectsOnMainSince(mainBefore));
        Assert.Equal(TrackedModSettledOutcome.NoQuestion, TestEditService.Settled(_notifications).Handle(_loadOrder, _modFolder));
    }

    [Fact]
    public async Task Absorb_WhenOnlyTheParkedRefCannotMove_RefusesThePlugin_SayingTheBaselineLandedAndNamingTheRef()
    {
        var mainBefore = Git("rev-parse", "refs/heads/main").Trim();
        WritePlugin(Second, heightMax: 2.0f);
        RefMoveHook.RefuseEveryMoveOf(_modFolder, SourceRepository.LastCompileRef(Second));

        var result = await Absorb();

        Assert.Empty(result.Landed);
        var refused = Assert.Single(result.Refused);
        Assert.Equal((new PluginAddress(Second, Origin), TrackRefusal.CommitFailed), (refused.Plugin, refused.Refusal));
        Assert.Equal([$"Update {Second}"], SubjectsOnMainSince(mainBefore));
        Assert.Contains($"landed on main, but {SourceRepository.LastCompileRef(Second)} could not be moved", refused.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("could not be committed", refused.Message, StringComparison.Ordinal);
        Assert.Null(result.TrackedFilesRefusal);
    }

    [Fact]
    public async Task Absorb_WithAPluginThatCannotBeRead_RefusesNamingThePluginItsOriginAndWhy_AndLeavesMainAlone()
    {
        var mainBefore = Git("rev-parse", "refs/heads/main").Trim();
        ChangeBothPluginsAndTheAsset();
        var unreadable = Path.Combine(_modFolder, Second);
        FileModes.Set(unreadable, "000");
        try
        {
            var result = await Absorb();

            var refusal = result.AnswerRefusal.Require();
            Assert.Equal(TrackRefusal.RoundTripFailed, refusal.Refusal);
            Assert.Contains($"{Second} ({Origin})", refusal.Message, StringComparison.Ordinal);
            Assert.Contains("denied", refusal.Message, StringComparison.Ordinal);
            Assert.Equal(mainBefore, Git("rev-parse", "refs/heads/main").Trim());
        }
        finally
        {
            FileModes.Set(unreadable, "600");
        }
    }

    [Fact]
    public async Task Absorb_OfAModWhoseMetaIniRecordsAVersion_NamesTheVersionInEachPluginsSubject()
    {
        var mainBefore = Git("rev-parse", "refs/heads/main").Trim();
        File.WriteAllText(Path.Combine(_modFolder, "meta.ini"), "version=2.0.0\n");
        ChangeBothPluginsAndTheAsset();
        RefMoveHook.RefuseMainMovesNaming(_modFolder, Second);

        var result = await Absorb();

        Assert.Equal([$"Update {First} to 2.0.0"], SubjectsOnMainSince(mainBefore));
        Assert.Contains($"'Update {Second} to 2.0.0' could not be committed to main", Assert.Single(result.Refused).Message, StringComparison.Ordinal);
    }

    // The scratch work tree is Absorb's own; failing to remove it is no failure of the answer.
    [Fact]
    public async Task Absorb_WhenItsScratchTreeCannotBeRemoved_StillAnswersEveryPluginApplied()
    {
        ChangeBothPluginsAndTheAsset();
        var held = Path.Combine(_instanceRoot, "held-scratch-tree");
        RefMoveHook.AfterMainMovesNaming(_modFolder, First, $"pwd > '{held}'; chmod 500 .");
        try
        {
            var result = await Absorb();

            Assert.Equal([new PluginAddress(First, Origin), new PluginAddress(Second, Origin)], result.Landed);
            Assert.Empty(result.Refused);
            Assert.Null(result.TrackedFilesRefusal);
        }
        finally
        {
            if (File.Exists(held) && File.ReadAllText(held).Trim() is { Length: > 0 } scratch && Directory.Exists(scratch))
            {
                FileModes.Set(scratch, "700");
                Directory.Delete(scratch, recursive: true);
            }
        }
    }

    [Fact]
    public async Task Absorb_WhenTheTrackedFilesCannotBeStagedAfterEverythingLanded_AnswersThePluginsApplied_AndTheTrackedFilesRefused()
    {
        var mainBefore = Git("rev-parse", "refs/heads/main").Trim();
        ChangeBothPluginsAndTheAsset();
        SourceRepository.RaiseExternalChangeQuestion(_modFolder, "unanswered");
        File.WriteAllText(Path.Combine(_modFolder, ".git", "index.lock"), "");

        var result = await Absorb();

        Assert.Equal([new PluginAddress(First, Origin), new PluginAddress(Second, Origin)], result.Landed);
        Assert.Empty(result.Refused);
        Assert.Contains("index.lock", result.TrackedFilesRefusal, StringComparison.Ordinal);
        Assert.Equal([$"Update {First}", $"Update {Second}", $"Update {Origin}"], SubjectsOnMainSince(mainBefore));
        Assert.NotNull(SourceRepository.UnansweredExternalChange(_modFolder));
    }

    [Fact]
    public async Task Absorb_AnsweredAgainAfterOnlyTheParkedRefFailed_MovesTheRefToTheBaselineOnMain_WithoutASecondCommit()
    {
        var mainBefore = Git("rev-parse", "refs/heads/main").Trim();
        WritePlugin(Second, heightMax: 2.0f);
        RefMoveHook.RefuseEveryMoveOf(_modFolder, SourceRepository.LastCompileRef(Second));
        await Absorb();
        var baselineOnMain = Git("rev-parse", "refs/heads/main").Trim();
        RefMoveHook.Remove(_modFolder);

        var result = await Absorb();

        Assert.True(result.AllApplied);
        Assert.Equal([new PluginAddress(Second, Origin)], result.Landed);
        Assert.Equal([$"Update {Second}"], SubjectsOnMainSince(mainBefore));
        Assert.Equal(baselineOnMain, Git("rev-parse", SourceRepository.LastCompileRef(Second)).Trim());
        Assert.Equal(TrackedModSettledOutcome.NoQuestion, TestEditService.Settled(_notifications).Handle(_loadOrder, _modFolder));
    }

    [Fact]
    public async Task Absorb_AnsweredAgainAfterTheTrackedFilesCouldNotBeStaged_StagesThem_WithoutASecondCommit()
    {
        var mainBefore = Git("rev-parse", "refs/heads/main").Trim();
        ChangeBothPluginsAndTheAsset();
        var indexLock = Path.Combine(_modFolder, ".git", "index.lock");
        File.WriteAllText(indexLock, "");
        await Absorb();
        File.Delete(indexLock);

        var result = await Absorb();

        Assert.True(result.AllApplied);
        Assert.Equal([$"Update {First}", $"Update {Second}", $"Update {Origin}"], SubjectsOnMainSince(mainBefore));
        Assert.Equal(TrackedModSettledOutcome.NoQuestion, TestEditService.Settled(_notifications).Handle(_loadOrder, _modFolder));
    }

    private void ChangeBothPluginsAndTheAsset()
    {
        WritePlugin(First, heightMax: 2.0f);
        WritePlugin(Second, heightMax: 2.0f);
        File.WriteAllText(Path.Combine(_modFolder, Asset), "new pixels");
    }

    private QuestionOpenNotification Settle()
    {
        Assert.Equal(TrackedModSettledOutcome.QuestionOpened, TestEditService.Settled(_notifications).Handle(_loadOrder, _modFolder));
        return Assert.Single(_notifications.Notifications.OfType<QuestionOpenNotification>());
    }

    private async Task<AbsorbResult> Absorb() => (await _absorb.AbsorbAsync(Origin)).Require();

    private void WritePlugin(string plugin, float heightMax)
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(plugin), Fallout4Release.Fallout4);
        var race = mod.Races.AddNew($"{Path.GetFileNameWithoutExtension(plugin)}Race");
        var npc = mod.Npcs.AddNew($"{Path.GetFileNameWithoutExtension(plugin)}Npc");
        npc.Race.SetTo(race);
        npc.HeightMax = heightMax;
        mod.WriteToBinary(Path.Combine(_modFolder, plugin));
    }

    private string Git(params string[] args) => GitProbe.Run(Path.Combine(_modFolder, ".git"), _modFolder, args);

    private string[] SubjectsOnMainSince(string revision) =>
        Git("log", "--reverse", "--format=%s", $"{revision}..refs/heads/main").Split('\n', StringSplitOptions.RemoveEmptyEntries);

    private string[] PathsIn(string revision) =>
        Git("show", "--name-only", "--format=", revision).Split('\n', StringSplitOptions.RemoveEmptyEntries);
}
