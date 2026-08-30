using MEditService.Core.Records;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Tests.RealData;

// #589: the profile harness's report is built from the load path's own log lines, for a cold run
// and a warm run of the same order. These pin the parse against the current wordings and the
// side-by-side shape of the report, so the harness itself (env-gated, minutes long) is never the
// first place a drifted log text is noticed.
public sealed class LoadOrderProfileReportTests
{
    private static LogEntry L(string message) => new(LogLevel.Debug, message);

    private static readonly LogEntry[] ColdLines =
    [
        L("DuckDB record repository initialized in 40 ms"),
        L("Validated 0 indexed plugin(s) against disk in 1 ms"),
        L("Fallout4.esm opened in 100 ms + 900 ms metadata"),
        L("Indexing Fallout4.esm (1000 records)"),
        L("Index Fallout4.esm: documents 500 ms (prepare 300 ms, append 200 ms), extracted tables 50 ms, commit 20 ms"),
        L("Indexed Fallout4.esm in 600 ms"),
        L("Mine.esp opened in 5 ms + 10 ms metadata"),
        L("Indexing Mine.esp (5 records)"),
        L("Ingesting Mine.esp from its source tree (/src/Mine.esp)"),
        L("Ingested Mine.esp from source: deserialize 30 ms, index 25 ms, reconcile 7 ms"),
        L("Indexed Mine.esp in 25 ms"),
        L("Load order reconciled in 2000 ms: 2 arrived, 0 moved, 0 left, 2 held (first plugin usable after 1600 ms, winner sweep 12 ms)"),
    ];

    private static readonly LogEntry[] WarmLines =
    [
        L("DuckDB record repository initialized in 35 ms"),
        L("Validated 2 indexed plugin(s) against disk in 800 ms"),
        L("Fallout4.esm opened in 100 ms + 900 ms metadata"),
        L("Registering Fallout4.esm (1000 records), already indexed and unchanged on disk"),
        L("Mine.esp opened in 5 ms + 10 ms metadata"),
        L("Indexing Mine.esp (5 records)"),
        L("Ingesting Mine.esp from its source tree (/src/Mine.esp)"),
        L("Ingested Mine.esp from source: deserialize 30 ms, index 25 ms, reconcile 7 ms"),
        L("Indexed Mine.esp in 25 ms"),
        L("Load order reconciled in 1200 ms: 2 arrived, 0 moved, 0 left, 2 held (first plugin usable after 1000 ms, winner sweep 11 ms)"),
    ];

    [Fact]
    public void Parse_ReadsTheReconciledAndValidationLines()
    {
        var run = ProfileRun.Parse(ColdLines, wallMs: 2100);

        Assert.Equal(2100, run.WallMs);
        Assert.Equal(40, run.RepoInitMs);
        Assert.Equal(1, run.ValidateMs);
        Assert.Equal(0, run.ValidatedCount);
        Assert.Equal(2000, run.ReconciledMs);
        Assert.Equal("1600", run.FirstUsableMs);
        Assert.Equal(12, run.WinnersMs);
    }

    [Fact]
    public void Parse_AttributesPerPluginPhases_AndCountsIndexedAgainstRegistered()
    {
        var cold = ProfileRun.Parse(ColdLines, wallMs: 2100);
        var esm = cold.Costs["Fallout4.esm"];
        Assert.Equal(1000, esm.OpenMs);
        Assert.Equal(600, esm.IndexMs);
        Assert.Equal((500, 300, 200, 50, 20), (esm.DocumentsMs, esm.PrepareMs, esm.AppendMs, esm.ExtractedMs, esm.CommitMs));
        Assert.True(cold.Costs["Mine.esp"].FromSource);
        Assert.Equal(2, cold.IndexedCount);
        Assert.Equal(0, cold.RegisteredCount);

        // A warm run registers the untracked plugin and re-ingests the tracked one (ADR-0041/0042).
        var warm = ProfileRun.Parse(WarmLines, wallMs: 1300);
        Assert.Equal(1, warm.RegisteredCount);
        Assert.Equal(1, warm.IndexedCount);
        Assert.Equal(0, warm.Costs["Fallout4.esm"].IndexMs);
        Assert.Equal(2, warm.ValidatedCount);
        Assert.Equal(800, warm.ValidateMs);
    }

    // The regexes parse Debug lines by their wording; a rewording must fail loudly, not zero a phase.
    [Fact]
    public void Parse_Throws_WhenTheReconciledLineIsMissing()
    {
        var ex = Assert.Throws<InvalidOperationException>(() => ProfileRun.Parse([L("Load order fully loaded in 5 ms")], wallMs: 5));
        Assert.Contains("update the regexes", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Render_PutsColdAndWarmSideBySide()
    {
        var cold = ProfileRun.Parse(ColdLines, wallMs: 2100);
        var warm = ProfileRun.Parse(WarmLines, wallMs: 1300);
        var header = new ProfileHeader("/inst", "Default", "/game/Data", ExplicitCount: 2, OpenedCount: 2, FailureCount: 0);
        var records = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase) { ["Fallout4.esm"] = 1000, ["Mine.esp"] = 5 };

        var report = LoadOrderProfileReport.Render(header, cold, warm, records, failures: []);

        Assert.Contains("| Phase | cold ms | warm ms |", report, StringComparison.Ordinal);
        Assert.Contains("| Wall clock (Reconcile round trip) | 2,100 | 1,300 |", report, StringComparison.Ordinal);
        Assert.Contains("| Validate indexed files against disk (hash) | 1 | 800 |", report, StringComparison.Ordinal);
        Assert.Contains("| Index (all plugins) | 625 | 25 |", report, StringComparison.Ordinal);
        Assert.Contains("Cold: reconciled in 2,000 ms, first plugin usable after 1600 ms, 2 indexed, 0 registered", report, StringComparison.Ordinal);
        Assert.Contains("Warm: reconciled in 1,200 ms, first plugin usable after 1000 ms, 1 indexed, 1 registered", report, StringComparison.Ordinal);
        Assert.Contains("| Fallout4.esm | 1,000 | 1,000 | 600 |", report, StringComparison.Ordinal);
    }

    // A cold run that indexed nothing means the harness measured a warm run twice (the index file
    // was not cleared) or the log wording drifted — either way the cold column would be a lie.
    [Fact]
    public void Render_Throws_WhenTheColdRunIndexedNothing()
    {
        var notCold = ProfileRun.Parse(WarmLines.Where(l => !l.Message.StartsWith("Indexed ", StringComparison.Ordinal)).ToList(), wallMs: 1300);
        var header = new ProfileHeader("/inst", "Default", "/game/Data", 2, 2, 0);
        Assert.Throws<InvalidOperationException>(() =>
            LoadOrderProfileReport.Render(header, notCold, notCold, new Dictionary<string, int>(), failures: []));
    }

    // The harness end to end, minus the real instance: the same load → dispose → load the env-gated
    // run does, over a fixture, parsing the load path's *actual* lines. This is where a reworded
    // timing line fails first.
    [Fact]
    public void Measure_ColdThenWarm_ParsesTheRealLogLines_AndTheWarmRunRegistersEverything()
    {
        using var data = new PluginFixtureBuilder("profile-harness")
            .WithPlugin("A.esp", m => m.Npcs.AddNew("NpcA"))
            .WithPlugin("B.esp", m => m.Npcs.AddNew("NpcB"))
            .Build();
        Assert.False(File.Exists(IndexFile.For(data.InstanceRoot)));

        var cold = LoadOrderProfile.Measure(data.InstanceRoot, data.DataFolder, data.Plugins, out var held);
        var warm = LoadOrderProfile.Measure(data.InstanceRoot, data.DataFolder, data.Plugins, out _);

        Assert.Equal(0, cold.RegisteredCount);
        Assert.True(cold.IndexedCount >= 2, $"cold indexed {cold.IndexedCount}");
        Assert.Equal(0, warm.IndexedCount);
        Assert.Equal(cold.IndexedCount, warm.RegisteredCount);
        Assert.Equal(cold.IndexedCount, warm.ValidatedCount);
        Assert.True(cold.Costs["A.esp"].IndexMs >= 0 && cold.Costs.ContainsKey("B.esp"));

        var records = held.Plugins.ToDictionary(p => p.Name, p => p.RecordCount, StringComparer.OrdinalIgnoreCase);
        var report = LoadOrderProfileReport.Render(
            new ProfileHeader(data.InstanceRoot, "fixture", data.DataFolder, data.Plugins.Count, held.Plugins.Count, held.Failures.Count),
            cold, warm, records, held.Failures);
        Assert.Contains("| Phase | cold ms | warm ms |", report, StringComparison.Ordinal);
    }
}
