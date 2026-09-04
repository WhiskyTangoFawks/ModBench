using MEditService.Core.Source;

namespace MEditService.Tests.Source;

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
    public void RunBatch_WhenEveryPluginLands_ClearsTheMarker()
    {
        CompileJournal.RunBatch(_modFolder, ["A.esp", "B.esp"], _ => true);

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
    public void RunBatch_CrashBetweenTwoPluginsWrites_LeavesAMarkerNamingExactlyWhatLanded()
    {
        Assert.Throws<InvalidOperationException>(() =>
            CompileJournal.RunBatch(_modFolder, ["A.esp", "B.esp", "C.esp"], plugin =>
                plugin == "B.esp" ? throw new InvalidOperationException("simulated crash") : true));

        var recovery = CompileJournal.UnfinishedBatch(_modFolder);
        Assert.NotNull(recovery);
        Assert.Equal(["A.esp", "B.esp", "C.esp"], recovery.Plugins);
        Assert.Equal(["A.esp"], recovery.Landed);
        Assert.Equal(["B.esp", "C.esp"], recovery.Unlanded);
    }

    [Fact]
    public void RunBatch_APluginThatRefuses_StopsTheBatch_AndLeavesItInTheUnlandedSet()
    {
        var landed = CompileJournal.RunBatch(_modFolder, ["A.esp", "B.esp", "C.esp"], plugin => plugin != "B.esp");

        Assert.Equal(["A.esp"], landed);
        var recovery = CompileJournal.UnfinishedBatch(_modFolder);
        Assert.NotNull(recovery);
        Assert.Equal(["B.esp", "C.esp"], recovery.Unlanded);
    }

    [Fact]
    public void RunBatch_OfOnePlugin_BehavesTheSameAsAnyOtherBatch()
    {
        CompileJournal.RunBatch(_modFolder, ["Solo.esp"], _ => true);

        Assert.Null(CompileJournal.UnfinishedBatch(_modFolder));
    }
}
