namespace MEditService.SourceAdapter.Tests.Source;

/// <summary>compile-plugin, steps 5 and 7: the mark a compile leaves in the mod's repository names
/// every plugin whose compile began and did not finish, until that plugin compiles.</summary>
public sealed class CompileJournalTests : IDisposable
{
    private readonly string _modFolder = Directory.CreateTempSubdirectory("medit-journal-").FullName;

    public CompileJournalTests() => Directory.CreateDirectory(Path.Combine(_modFolder, ".git"));

    public void Dispose()
    {
        try { Directory.Delete(_modFolder, recursive: true); }
        catch (IOException) { /* scratch, best-effort */ }
    }

    private Task<bool> Lands(string plugin) => CompileJournal.RunAsync(_modFolder, plugin, () => Task.FromResult(true));

    private Task<bool> IsRefused(string plugin) => CompileJournal.RunAsync(_modFolder, plugin, () => Task.FromResult(false));

    private Task Crashes(string plugin) => Assert.ThrowsAsync<InvalidOperationException>(() =>
        CompileJournal.RunAsync(_modFolder, plugin, () => throw new InvalidOperationException("simulated crash")));

    private IReadOnlyList<string>? Unlanded() => CompileJournal.UnfinishedBatch(_modFolder)?.Unlanded;

    [Fact]
    public void NothingEverCompiled_LeavesNoMark()
    {
        Assert.Null(Unlanded());
    }

    [Fact]
    public async Task ACompileThatLands_LeavesNoMark()
    {
        Assert.True(await Lands("A.esp"));

        Assert.Null(Unlanded());
    }

    [Fact]
    public async Task ACompileThatCrashes_LeavesAMarkNamingThePlugin()
    {
        await Crashes("A.esp");

        Assert.Equal(["A.esp"], Unlanded());
    }

    [Fact]
    public async Task TheMark_NamesThePlugin_WhileItsCompileRuns()
    {
        IReadOnlyList<string>? whileRunning = null;

        await CompileJournal.RunAsync(_modFolder, "A.esp", () =>
        {
            whileRunning = Unlanded();
            return Task.FromResult(true);
        });

        Assert.Equal(["A.esp"], whileRunning);
    }

    [Fact]
    public async Task ARefusedCompile_WroteNothing_SoLeavesNoMark()
    {
        Assert.False(await IsRefused("A.esp"));

        Assert.Null(Unlanded());
    }

    [Fact]
    public async Task ARefusedCompile_OfAPluginAnEarlierCrashLeftUnfinished_KeepsItMarked()
    {
        await Crashes("B.esp");

        await IsRefused("B.esp");

        Assert.Equal(["B.esp"], Unlanded());
    }

    [Fact]
    public async Task ACompileOfAnotherPluginOfTheMod_KeepsAnInterruptedPluginMarked()
    {
        await Crashes("B.esp");

        await Lands("A.esp");

        Assert.Equal(["B.esp"], Unlanded());
    }

    [Fact]
    public async Task ARefusedCompileOfAnotherPluginOfTheMod_KeepsAnInterruptedPluginMarked()
    {
        await Crashes("B.esp");

        await IsRefused("A.esp");

        Assert.Equal(["B.esp"], Unlanded());
    }

    [Fact]
    public async Task TheInterruptedPluginCompilingAgain_ClearsTheMark()
    {
        await Crashes("B.esp");
        await Lands("A.esp");

        await Lands("B.esp");

        Assert.Null(Unlanded());
        Assert.False(File.Exists(Path.Combine(_modFolder, ".git", "MEDIT_COMPILE_JOURNAL")));
    }

    [Fact]
    public async Task APluginThatLandedSinceTheMarkWasLeft_IsMarkedAgain_WhenItsNextCompileCrashes()
    {
        await Crashes("B.esp");
        await Lands("A.esp");

        await Crashes("A.esp");

        Assert.Equal(["B.esp", "A.esp"], Unlanded());
    }

    // No door leaves this mark: only a crash between a compile landing and the mark's deletion does,
    // so the mark is laid down as that crash leaves it.
    [Fact]
    public void AMarkWhoseEveryPluginLanded_NamesNoUnfinishedCompile()
    {
        File.WriteAllText(
            Path.Combine(_modFolder, ".git", "MEDIT_COMPILE_JOURNAL"),
            """{"plugins":["A.esp","B.esp"],"landed":["A.esp","B.esp"]}""");

        Assert.Null(CompileJournal.UnfinishedBatch(_modFolder));
    }
}
