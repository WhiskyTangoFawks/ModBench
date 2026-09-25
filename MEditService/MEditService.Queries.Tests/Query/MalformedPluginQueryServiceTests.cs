using MEditService.Codec.Serialization;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.Queries;
using MEditService.Queries.Tests.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Queries.Tests.Query;

/// <summary>A diagnosis is a row the Index projected when it hashed the binary; this service joins
/// those rows to the load order, which says which plugins an edit can reach and in what order they
/// are read.</summary>
public sealed class MalformedPluginQueryServiceTests
{
    private const string Malformed = "LitR - TrueStorms.esp";

    private static readonly PluginDiagnosis Short = new(
        "REGN 001D2AF4 (DowntownRegion)", "fixed-size-subrecord-short", "repairable (lossless)",
        "RDAT is 6 bytes; a REGN RDAT is always 8");

    private static readonly PluginDiagnosis Trailing = new(
        "NPC_ 00012345 (Sierra)", "trailing-bytes", "repairable (lossless)", "3 bytes past the last subrecord");

    private static RegisteredPlugin Plugin(string name, string origin = "SomeMod", bool isForced = false, int? slot = 0) =>
        new(name, origin, $@"C:\mods\{origin}\{name}", slot, Enabled: true, Winning: true, IsForced: isForced);

    private static PluginDiagnosisRow Row(RegisteredPlugin plugin, PluginDiagnosis diagnosis) => new(plugin.Key, diagnosis);

    private static PluginDiagnosisReport[] Diagnose(
        IReadOnlyList<PluginDiagnosisRow> rows, params RegisteredPlugin[] plugins) =>
        [.. new MalformedPluginQueryService(
            new FakeIndex(new FakeReads(new Dictionary<PluginAddress, PluginContent>(), []) { Diagnoses = rows }),
            FakeLoadOrder.Of(GameRelease.Fallout4, plugins))
            .GetLoadOrderDiagnoses()];

    [Fact]
    public void GetLoadOrderDiagnoses_ARowAgainstAHeldPlugin_IsReportedWithTheRefusalWording()
    {
        var plugin = Plugin(Malformed);

        var report = Assert.Single(Diagnose([Row(plugin, Short)], plugin));

        Assert.Equal(Malformed, report.Plugin);
        Assert.Equal("SomeMod", report.Origin);
        Assert.Equal("REGN 001D2AF4 (DowntownRegion)", report.Anchor);
        Assert.Equal("fixed-size-subrecord-short", report.DefectClass);
        Assert.Equal("repairable (lossless)", report.Tail);
        Assert.Equal("RDAT is 6 bytes; a REGN RDAT is always 8", report.Message);
        // Verbatim PluginDiagnosis.Describe(): the Problems panel and the Track refusal must never
        // develop separate vocabularies.
        Assert.Equal(
            "REGN 001D2AF4 (DowntownRegion) — fixed-size-subrecord-short, repairable (lossless): "
            + "RDAT is 6 bytes; a REGN RDAT is always 8",
            report.Text);
    }

    // Immutable plugins are the proof set the tables were built from, so a hit there
    // is a table bug. The Index stamps every plugin it hashes, so the load order drops these.
    [Fact]
    public void GetLoadOrderDiagnoses_RowsOfAForcedPlugin_AreNeverReported()
    {
        var forced = Plugin("Fallout4.esm", origin: "Data", isForced: true);

        Assert.Empty(Diagnose([Row(forced, Short)], forced));
    }

    [Fact]
    public void GetLoadOrderDiagnoses_RowsOfAPluginNoListLineNames_AreNeverReported()
    {
        var unlisted = Plugin(Malformed, slot: null);

        Assert.Empty(Diagnose([Row(unlisted, Short)], unlisted));
    }

    // A plugin the Index never opened stamps no rows, and neither does a clean one; a plugin that
    // failed to load says so through LoadOrderStatus.Failures.
    [Fact]
    public void GetLoadOrderDiagnoses_APluginWithNoRows_IsNotReported()
    {
        Assert.Empty(Diagnose([], Plugin("Clean.esp")));
    }

    [Fact]
    public void GetLoadOrderDiagnoses_ARowNamingAPluginTheLoadOrderDoesNotHold_IsNotReported()
    {
        var held = Plugin("Held.esp");
        var gone = Plugin(Malformed, origin: "RemovedMod");

        Assert.Empty(Diagnose([Row(gone, Short)], held));
    }

    // ADR-0012 invariant 1: a filename is not an identity — origin tells two plugins of one apart.
    [Fact]
    public void GetLoadOrderDiagnoses_TwoPluginsOfOneName_ReportAgainstTheirOwnOrigins()
    {
        var winner = Plugin(Malformed, origin: "WinningMod");
        var loser = Plugin(Malformed, origin: "LosingMod", slot: 1);

        var reports = Diagnose([Row(loser, Short)], winner, loser);

        Assert.Equal("LosingMod", Assert.Single(reports).Origin);
    }

    // The load order is the order, and within one plugin the rows keep the order the binary proved
    // them in.
    [Fact]
    public void GetLoadOrderDiagnoses_AreOrderedByTheLoadOrderThenByRecordOrder()
    {
        var first = Plugin("First.esp", origin: "FirstMod");
        var second = Plugin("Second.esp", origin: "SecondMod", slot: 1);

        var reports = Diagnose([Row(second, Short), Row(first, Short), Row(first, Trailing)], first, second);

        Assert.Equal(
            [("First.esp", "fixed-size-subrecord-short"), ("First.esp", "trailing-bytes"),
             ("Second.esp", "fixed-size-subrecord-short")],
            reports.Select(r => (r.Plugin, r.DefectClass)));
    }

    // MEditService/CLAUDE.md: a whole-plugin-set derivation gates on Status, because a plugin the
    // projection has not reached has no rows yet and would read clean. GetPlugins answers its own
    // whole-set fact the same way while reconciling.
    [Fact]
    public void GetLoadOrderDiagnoses_WhileReconciling_AnswersNothing()
    {
        var plugin = Plugin(Malformed);
        var reads = new FakeReads(new Dictionary<PluginAddress, PluginContent>(), []) { Diagnoses = [Row(plugin, Short)] };
        var reconciling = new LoadOrderStatus(
            LoadOrderState.Reconciling, TotalPlugins: 1, [], ConflictsComputed: false, []);

        var reports = new MalformedPluginQueryService(
            new FakeIndex(reads, reconciling), FakeLoadOrder.Of(GameRelease.Fallout4, plugin))
            .GetLoadOrderDiagnoses();

        Assert.Empty(reports);
    }

    [Fact]
    public void GetLoadOrderDiagnoses_WithNoLoadOrderHeld_Throws()
    {
        var service = new MalformedPluginQueryService(
            new FakeIndex(new FakeReads(new Dictionary<PluginAddress, PluginContent>(), [])),
            new LoadOrderHolder());

        Assert.Throws<NoLoadOrderException>(service.GetLoadOrderDiagnoses);
    }
}
