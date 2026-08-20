using MEditService.Core.Ledger;

namespace MEditService.Tests.Ledger;

/// <summary>
/// #416 S9: the reduced-form compile journal — multi-plugin compile is atomic under a crash injected
/// between writes, meaning the marker always tells a reader exactly which plugins landed and which
/// didn't, never leaving a batch's outcome ambiguous.
/// </summary>
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

        Assert.Null(CompileJournal.PendingRecovery(_modFolder));
    }

    [Fact]
    public void RunBatch_WhenNothingIsInFlight_ReportsNoPendingRecovery()
    {
        Assert.Null(CompileJournal.PendingRecovery(_modFolder));
    }

    // The crash-injection scenario the AC names directly: a crash between two plugins' writes. Not
    // literally killing the process — the same observable state a real crash leaves (the marker
    // written before the batch, updated after the first plugin landed, never reaching the "delete"
    // step) is reproduced by a compileOne that throws for the second plugin, and the marker file is
    // asserted directly rather than through RunBatch's own return value, so the assertion is honest
    // about what a *restarted* process would actually see on disk.
    [Fact]
    public void RunBatch_CrashBetweenTwoPluginsWrites_LeavesAMarkerNamingExactlyWhatLanded()
    {
        Assert.Throws<InvalidOperationException>(() =>
            CompileJournal.RunBatch(_modFolder, ["A.esp", "B.esp", "C.esp"], plugin =>
                plugin == "B.esp" ? throw new InvalidOperationException("simulated crash") : true));

        var recovery = CompileJournal.PendingRecovery(_modFolder);
        Assert.NotNull(recovery);
        Assert.Equal(["A.esp", "B.esp", "C.esp"], recovery.Plugins);
        Assert.Equal(["A.esp"], recovery.Landed);
        Assert.Equal(["B.esp", "C.esp"], recovery.Pending);
    }

    [Fact]
    public void RunBatch_APluginThatRefuses_StopsTheBatch_AndLeavesItInThePendingSet()
    {
        var landed = CompileJournal.RunBatch(_modFolder, ["A.esp", "B.esp", "C.esp"], plugin => plugin != "B.esp");

        Assert.Equal(["A.esp"], landed);
        var recovery = CompileJournal.PendingRecovery(_modFolder);
        Assert.NotNull(recovery);
        Assert.Equal(["B.esp", "C.esp"], recovery.Pending);
    }

    [Fact]
    public void RunBatch_OfOnePlugin_BehavesTheSameAsAnyOtherBatch()
    {
        CompileJournal.RunBatch(_modFolder, ["Solo.esp"], _ => true);

        Assert.Null(CompileJournal.PendingRecovery(_modFolder));
    }
}
