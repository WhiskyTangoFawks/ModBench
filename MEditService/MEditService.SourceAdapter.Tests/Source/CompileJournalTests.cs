namespace MEditService.SourceAdapter.Tests.Source;

/// <summary>Multi-plugin compile is atomic under a crash injected between writes: the marker always
/// tells a reader which plugins landed.</summary>
public sealed class CompileJournalTests : IDisposable
{
    private readonly string _modFolder = Directory.CreateTempSubdirectory("medit-journal-").FullName;

    public CompileJournalTests() => Directory.CreateDirectory(Path.Combine(_modFolder, ".git"));

    public void Dispose()
    {
        try { Directory.Delete(_modFolder, recursive: true); }
        catch (IOException) { /* scratch, best-effort */ }
    }

    [Fact]
    public async Task RunBatch_WhenEveryPluginLands_ClearsTheMarker()
    {
        await CompileJournal.RunBatchAsync(_modFolder, ["A.esp", "B.esp"], _ => Task.FromResult(true));

        Assert.Null(CompileJournal.UnfinishedBatch(_modFolder));
    }

    [Fact]
    public void RunBatch_WhenNothingIsInFlight_ReportsNoUnfinishedBatch()
    {
        Assert.Null(CompileJournal.UnfinishedBatch(_modFolder));
    }

    // A crash between two plugins' writes, reproduced by a compileOne that throws for the second. The
    // marker file is asserted directly rather than through RunBatch's return value, so it is honest
    // about what a restarted process would see.
    [Fact]
    public async Task RunBatch_CrashBetweenTwoPluginsWrites_LeavesAMarkerNamingExactlyWhatLanded()
    {
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            CompileJournal.RunBatchAsync(_modFolder, ["A.esp", "B.esp", "C.esp"], plugin =>
                plugin == "B.esp" ? throw new InvalidOperationException("simulated crash") : Task.FromResult(true)));

        var recovery = CompileJournal.UnfinishedBatch(_modFolder);
        Assert.NotNull(recovery);
        Assert.Equal(["A.esp", "B.esp", "C.esp"], recovery.Plugins);
        Assert.Equal(["A.esp"], recovery.Landed);
        Assert.Equal(["B.esp", "C.esp"], recovery.Unlanded);
    }

    [Fact]
    public async Task RunBatch_APluginThatRefuses_StopsTheBatch_AndLeavesItInTheUnlandedSet()
    {
        var landed = await CompileJournal.RunBatchAsync(_modFolder, ["A.esp", "B.esp", "C.esp"], plugin => Task.FromResult(plugin != "B.esp"));

        Assert.Equal(["A.esp"], landed);
        var recovery = CompileJournal.UnfinishedBatch(_modFolder);
        Assert.NotNull(recovery);
        Assert.Equal(["B.esp", "C.esp"], recovery.Unlanded);
    }

    [Fact]
    public async Task RunBatch_OfOnePlugin_BehavesTheSameAsAnyOtherBatch()
    {
        await CompileJournal.RunBatchAsync(_modFolder, ["Solo.esp"], _ => Task.FromResult(true));

        Assert.Null(CompileJournal.UnfinishedBatch(_modFolder));
    }
}
